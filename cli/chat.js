#!/usr/bin/env node
// agent-engine chat — a terminal chatbot over the engine.
//
//   npm run chat
//
// Everything platform-specific lives in this directory: the transcript store,
// the settings file, the slash commands, this REPL. The engine below it still
// receives { userId, conversationId, text } and returns text, exactly as it
// does for any other host.
//
// Load order matters. Settings that map to engine configuration must reach
// process.env before `../index.js` is required, because the agent loop
// destructures config at module load.

require("dotenv").config();

const readline = require("readline");
const settingsModule = require("./settings");

const loaded = settingsModule.load();
const settings = loaded.values;
settingsModule.applyToEnv(settings);

const engine = require("../index.js");
const store = require("./store");
const commands = require("./commands");

function out(line = "") { console.log(line); }

function saveSettings() { settingsModule.save(settings); }

// Built-ins plus one local tool, to show the extension point in the place a
// user of this CLI would actually add theirs.
const registry = new engine.ToolRegistry()
  .registerAll(engine.BUILTIN_TOOLS)
  .register({
    name: "get_local_time",
    description: "Get the current local time and timezone of this machine.",
    parameters: { type: "object", properties: {}, required: [] },
    sideEffect: false,
    handler: async () => ({
      iso: new Date().toISOString(),
      local: new Date().toLocaleString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
  });

const emptyRegistry = new engine.ToolRegistry();

async function runTurn(ctx, text) {
  const messageId = `cli-${Date.now()}`;
  const timestamp = Date.now();

  const result = await engine.run(
    {
      userId: settings.userId,
      userName: settings.userName,
      conversationId: ctx.session.id,
      scopeId: settings.scopeId,
      text,
      messageId,
      timestamp,
    },
    {
      registry: settings.tools ? registry : emptyRegistry,
      history: store.historyForEngine(ctx.session.id, settings.historyDepth),
      updateMemory: settings.memory,
      ...(settings.persona ? { persona: settings.persona } : {}),
      ...(settings.toolDepth ? { maxToolDepth: settings.toolDepth } : {}),
      ...(settings.stream
        ? {
          stream: {
            onChunk: (delta) => process.stdout.write(delta),
            onAbort: () => process.stdout.write("\r"),
          },
        }
        : {}),
    },
  );

  // The engine reports a failed turn rather than throwing. Nothing is written
  // to the transcript in that case — a saved history that contains a user line
  // with no reply reads as if the model ignored them.
  if (result.error) {
    out(`\n[error] ${result.error}\n`);
    return;
  }

  if (!result.streamed && result.text) out(result.text);
  out("");

  for (const a of result.attachments) {
    out(`[attachment] ${a.filename} (${a.mimeType}, ${a.buffer.length} bytes)`);
  }
  const toolsUsed = result.toolCalls.map(t => t.tool);
  if (settings.showTools && toolsUsed.length > 0) out(`[tools] ${toolsUsed.join(", ")}`);
  // cost_usd arrives as a fixed-precision string from the router's estimator.
  const costUsd = Number(result.usage?.cost_usd) || 0;
  if (settings.showUsage && result.usage) {
    out(`[usage] ${result.usage.total_tokens ?? "?"} tokens, $${costUsd.toFixed(5)}`);
  }
  if (settings.showTools || settings.showUsage) out("");

  store.appendMessage({
    sessionId: ctx.session.id, messageId, role: "user",
    userId: settings.userId, userName: settings.userName, text,
  });
  if (result.text) {
    store.appendMessage({
      sessionId: ctx.session.id, messageId: `${messageId}-r`, role: "assistant",
      userId: "agent", userName: "Assistant", text: result.text,
      tokens: result.usage?.total_tokens || 0,
      costUsd,
      tools: toolsUsed,
    });
  }

  // Keep the in-memory session row current so /stats and the prompt label do
  // not need a re-read after every turn. The one thing the store decides on its
  // own is the auto-title for an untitled session, so read that back.
  ctx.session.messageCount += result.text ? 2 : 1;
  if (!ctx.session.title) ctx.session.title = store.getSession(ctx.session.id)?.title || "";
}

function promptLabel(session) {
  const title = session.title ? session.title.slice(0, 24) : session.id;
  return `${title} > `;
}

async function main() {
  if (!process.env.LLM_API_KEY) {
    console.error("LLM_API_KEY is not set. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }
  if (loaded.warning) out(`[settings] ${loaded.warning}`);

  engine.jobs.registerDefaultHandlers(engine.jobs);
  // Reminder delivery has no default handler — only the host knows how to reach
  // a user. Here, that means printing above the prompt.
  engine.jobs.register("reminder", async (payload) => {
    out(`\n[reminder] ${payload.text}`);
  });
  engine.jobs.start();

  const session = store.latestSession() || store.createSession();

  const ctx = {
    session,
    settings,
    store,
    engine,
    registry,
    out,
    saveSettings,
    exit: false,
    setSession(next) { ctx.session = next; },
  };

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  out("agent-engine chat — /help for commands, /exit to quit.");
  out(`session ${ctx.session.id}${ctx.session.title ? `  ${ctx.session.title}` : ""} (${ctx.session.messageCount} messages)\n`);

  // The async iterator, not rl.question(): readline pauses the input stream
  // while the body awaits, so a piped or fast-typed line that lands mid-turn is
  // queued rather than dropped.
  rl.setPrompt(promptLabel(ctx.session));
  rl.prompt();

  for await (const raw of rl) {
    const line = raw.trim();
    if (line) {
      if (!commands.dispatch(line, ctx)) {
        try {
          await runTurn(ctx, line);
        } catch (err) {
          out(`\n[fatal] ${err.message}\n`);
        }
      }
    }
    if (ctx.exit) break;
    rl.setPrompt(promptLabel(ctx.session));
    rl.prompt();
  }

  rl.close();
  out("\nClosing databases…");
  store.close();
  engine.close();
  process.exit(0);
}

main();
