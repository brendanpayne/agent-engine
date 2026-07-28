#!/usr/bin/env node
// agent-engine chat — a terminal chat client over the engine.
//
//   npm run chat
//
// Everything platform-specific lives in this directory: the transcript store,
// the settings file, the slash commands, the renderer, this REPL. The engine
// below it still receives { userId, conversationId, text } and returns text,
// exactly as it does for any other host.
//
// This client is shaped like the chat platform the engine grew up hosting:
// sessions are channels, speakers are members, messages carry replies,
// attachments, reactions and pins, and structured output is drawn as embeds.
// All of that is client-side vocabulary — the engine still only sees the fields
// documented on AgentInput.
//
// Load order matters. Settings that map to engine configuration must reach
// process.env before `../index.js` is required, because the agent loop
// destructures config at module load.

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const settingsModule = require("./settings");

const loaded = settingsModule.load();
const settings = loaded.values;
settingsModule.applyToEnv(settings);

const engine = require("../index.js");
const store = require("./store");
const commands = require("./commands");
const autocomplete = require("./autocomplete");
const ui = require("./ui");

const pkg = require("../package.json");

function out(line = "") { console.log(line); }

function saveSettings() { settingsModule.save(settings); }

// Colour and theme live in the renderer, not in settings, so every draw call
// does not have to consult the settings object. Re-applied after every /set.
function applyAppearance() {
  ui.setTheme(settings.theme);
  ui.setColor(settings.color && settings.theme !== "mono");
}

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

// Anything queued for the next message: attachments from /attach, and the
// message a /reply is aimed at. Cleared once a message actually goes out.
const pending = { attachments: [] };

// --- Attachments -----------------------------------------------------------

const TEXTUAL = new Set([
  ".txt", ".md", ".markdown", ".json", ".jsonl", ".csv", ".tsv", ".yaml", ".yml",
  ".js", ".ts", ".jsx", ".tsx", ".py", ".rb", ".go", ".rs", ".java", ".c", ".h",
  ".cpp", ".sh", ".sql", ".html", ".css", ".xml", ".toml", ".ini", ".env", ".log",
]);

const MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".pdf": "application/pdf", ".json": "application/json",
  ".md": "text/markdown", ".csv": "text/csv", ".html": "text/html",
};

const PERCEPTION_LIMIT = 6000;

function clamp(text, limit = PERCEPTION_LIMIT) {
  const t = String(text);
  return t.length <= limit ? t : `${t.slice(0, limit)}\n… (truncated, ${t.length - limit} more characters)`;
}

// A file or a link becomes two things: an attachment record the engine passes
// through untouched, and readable text handed over as perception. That split is
// what the chat host did — the platform gives you a URL and a content type, and
// it is the host's job to turn that into something a text model can read.
async function resolveAttachment(ref) {
  if (/^https?:\/\//i.test(ref)) {
    if (!engine.isSafeUrl(ref)) throw new Error("That URL is not fetchable (blocked by the SSRF guard).");
    const page = await engine.fetchPageText(ref);
    const name = ref.replace(/^https?:\/\//, "").slice(0, 60);
    return {
      url: ref,
      name,
      contentType: "text/html",
      perception: page ? `[Link: ${ref}]\n${clamp(page)}` : null,
    };
  }

  const resolved = path.resolve(process.cwd(), ref);
  let stat;
  try { stat = fs.statSync(resolved); } catch (_) { throw new Error(`No such file: ${ref}`); }
  if (stat.isDirectory()) throw new Error("That is a directory, not a file.");

  const ext = path.extname(resolved).toLowerCase();
  const name = path.basename(resolved);
  const contentType = MIME[ext] || (TEXTUAL.has(ext) ? "text/plain" : "application/octet-stream");

  // Only read what a text model can actually use. A binary read here would put
  // megabytes of noise into the prompt for no benefit.
  let perception = null;
  if (TEXTUAL.has(ext) || contentType.startsWith("text/")) {
    perception = `[Attachment: ${name}]\n${clamp(fs.readFileSync(resolved, "utf8"))}`;
  }

  return { url: `file://${resolved}`, name, contentType, size: stat.size, perception };
}

// Links pasted straight into a message are resolved the same way, which is how
// the bot could talk about a page you dropped in the channel without being
// asked to go and fetch it.
async function perceptionForTurn(text, attachments) {
  const parts = attachments.map(a => a.perception).filter(Boolean);

  if (settings.urlContext) {
    const url = engine.extractFirstUrl(text);
    const alreadyAttached = attachments.some(a => a.url === url);
    if (url && !alreadyAttached && engine.isSafeUrl(url)) {
      try {
        const page = await engine.fetchPageText(url);
        if (page) parts.push(`[Link: ${url}]\n${clamp(page)}`);
      } catch (_) {
        // A dead link is not a reason to fail the turn; the model still has the
        // url itself in the message text.
      }
    }
  }

  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

// Media a tool produced comes back as a Buffer. Write it somewhere the user can
// open, since a terminal cannot show it inline the way a chat client would.
function saveAttachment(a) {
  const dir = path.resolve(process.cwd(), "attachments");
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${Date.now()}-${a.filename}`);
  fs.writeFileSync(target, a.buffer);
  return target;
}

// --- A turn ----------------------------------------------------------------

async function runTurn(ctx, text, opts = {}) {
  const messageId = `cli-${Date.now()}`;
  const timestamp = Date.now();
  const attachments = pending.attachments.splice(0, pending.attachments.length);
  const startedAt = Date.now();

  // Everyone who has spoken here recently, so per-participant facts anchor on
  // the right people rather than only on whoever is typing.
  const participants = store.members(ctx.session.id)
    .filter(m => !m.bot)
    .slice(0, 10)
    .map(m => ({ id: m.userId, name: m.userName }));

  const indicator = settings.typingIndicator ? ui.typing(settings.botName) : { stop() {} };
  let writer = null;
  let headerPrinted = false;

  // Live messages carry no ordinal: the number only becomes stable once the row
  // is written, and printing a guess would break /pin and /react. /history shows
  // the numbers, and the message-scoped commands take -1 for "the last one".
  const printHeader = () => {
    if (headerPrinted) return;
    headerPrinted = true;
    indicator.stop();
    out(ui.gutterHeader({
      name: settings.botName, bot: true, showSeq: false,
      timestamp: settings.timestamps ? Date.now() : null,
    }));
  };

  let perception;
  try {
    perception = await perceptionForTurn(text, attachments);
  } catch (_) {
    perception = undefined;
  }

  let result;
  try {
    result = await engine.run(
      {
        userId: settings.userId,
        userName: settings.userName,
        conversationId: ctx.session.id,
        conversationName: ctx.session.title || undefined,
        scopeId: settings.scopeId,
        text,
        messageId,
        timestamp,
        participants,
        ...(attachments.length > 0
          ? { attachments: attachments.map(a => ({ url: a.url, contentType: a.contentType, name: a.name })) }
          : {}),
        ...(perception ? { perception } : {}),
        ...(opts.replyContext ? { replyContext: opts.replyContext } : {}),
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
              onChunk: (delta) => {
                printHeader();
                if (!writer) {
                  writer = ui.streamWriter({
                    name: settings.botName, bot: true, render: settings.markdown,
                  });
                }
                writer.write(delta);
              },
              onAbort: () => { if (writer) writer.reset(); },
            },
          }
          : {}),
      },
    );
  } finally {
    indicator.stop();
  }

  if (writer) writer.end();
  const latencyMs = Date.now() - startedAt;

  // The engine reports a failed turn rather than throwing. Nothing is written
  // to the transcript in that case — a saved history that contains a user line
  // with no reply reads as if the model ignored them.
  if (result.error) {
    out("");
    for (const line of ui.embed({
      title: "Message failed", description: result.error, color: "#ED4245",
      footer: "Nothing was written to the transcript.",
    })) out(line);
    return;
  }

  if (!result.streamed && result.text) {
    printHeader();
    for (const line of ui.renderMarkdown(result.text, { indent: ui.gutter(settings.botName, true) })) {
      out(line);
    }
  }

  for (const a of result.attachments || []) {
    const saved = saveAttachment(a);
    out(ui.attachmentLine({ name: a.filename, url: saved, contentType: a.mimeType, size: a.buffer.length }));
  }

  // cost_usd arrives as a fixed-precision string from the router's estimator.
  const costUsd = Number(result.usage?.cost_usd) || 0;
  const toolsUsed = result.toolCalls.map(t => t.tool);
  const footer = [];
  if (settings.showTools && toolsUsed.length > 0) footer.push(`⚙ ${toolsUsed.join(", ")}`);
  if (settings.showUsage && result.usage) {
    footer.push(`${result.usage.total_tokens ?? "?"} tokens`, `$${costUsd.toFixed(5)}`);
  }
  if (settings.showLatency) footer.push(`${(latencyMs / 1000).toFixed(1)}s`);
  if (footer.length > 0) out(`    ${ui.c.muted(footer.join(ui.c.muted(" · ")))}`);
  out("");

  store.appendMessage({
    sessionId: ctx.session.id, messageId, role: "user",
    userId: settings.userId, userName: settings.userName, text,
    attachments: attachments.map(a => ({ url: a.url, name: a.name, contentType: a.contentType, size: a.size })),
    replyTo: opts.replyToId || "",
  });
  if (result.text) {
    store.appendMessage({
      sessionId: ctx.session.id, messageId: `${messageId}-r`, role: "assistant",
      userId: "agent", userName: settings.botName, text: result.text,
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

// --- Chrome ----------------------------------------------------------------

function channelName(session) {
  return store.channelName(session.title || session.id);
}

function promptLabel(session) {
  const channel = ui.c.accent(`#${channelName(session)}`);
  const who = ui.member(settings.userName);
  const marks = [];
  if (pending.attachments.length > 0) marks.push(ui.c.warn(`📎${pending.attachments.length}`));
  return `${channel} ${who}${marks.length > 0 ? ` ${marks.join("")}` : ""} ${ui.c.accent("›")} `;
}

function showChannelHeader(ctx) {
  out("");
  for (const line of ui.channelHeader({
    name: channelName(ctx.session),
    topic: ctx.session.topic,
    messageCount: ctx.session.messageCount,
    memberCount: store.members(ctx.session.id).length,
  })) out(line);
}

// --- Main ------------------------------------------------------------------

async function main() {
  applyAppearance();

  if (!process.env.LLM_API_KEY) {
    console.error("LLM_API_KEY is not set. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }

  engine.jobs.registerDefaultHandlers(engine.jobs);

  const session = store.latestSession() || store.createSession();

  const ctx = {
    session,
    settings,
    store,
    engine,
    registry,
    ui,
    pending,
    out,
    saveSettings,
    applyAppearance,
    resolveAttachment,
    startedAt: Date.now(),
    exit: false,
    setSession(next) { ctx.session = next; },
    send(text, opts) { return runTurn(ctx, text, opts); },
    showChannelHeader() { showChannelHeader(ctx); },
  };

  // Reminder delivery has no default handler — only the host knows how to reach
  // a user. Here that means an embed above the prompt, the way a bot would post
  // into the channel it was asked from. The readline handle is captured after
  // it exists so a reminder that fires early cannot reach into the dead zone.
  let rlRef = null;
  let pickerRef = null;
  engine.jobs.register("reminder", async (payload) => {
    // A reminder can land while the picker is open. Its rows sit below the
    // prompt, so anything printed now would land on top of them.
    if (pickerRef) pickerRef.clear();
    out("");
    for (const line of ui.embed({
      title: "⏰ Reminder", description: payload.text, color: "#FEE75C",
    })) out(line);
    if (rlRef) rlRef.prompt(true);
  });
  engine.jobs.start();

  for (const line of ui.banner({
    version: pkg.version,
    model: settings.model || engine.config.CONVO_MODEL,
  })) out(line);
  if (loaded.warning) out(`  ${ui.c.warn("!")} ${loaded.warning}`);

  showChannelHeader(ctx);
  const recent = store.lastMessages(ctx.session.id, 4);
  if (recent.length > 0) {
    for (const m of recent) {
      for (const l of ui.renderMessage(m, { compact: true, botName: settings.botName })) out(l);
    }
    out("");
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    // Completion is the picker's job, not readline's. This stub exists to claim
    // the Tab key: with no completer configured readline inserts a literal tab,
    // and with one that returns nothing it does nothing at all — leaving Tab
    // free for cli/autocomplete.js to handle as "next suggestion".
    completer(line) { return [[], line]; },
  });
  rlRef = rl;

  const picker = autocomplete.create({ rl, commands, ui, ctx });
  picker.attach(process.stdin);
  pickerRef = picker;
  // readline has echoed the newline by now, putting the cursor on the picker's
  // first row — so this is the one clear that must not move down first.
  rl.on("line", () => picker.clearAfterSubmit());

  // Ctrl-C abandons the line you are typing rather than the session; twice in a
  // row, or on an empty line, quits.
  let interrupted = false;
  rl.on("SIGINT", () => {
    picker.clear();
    if (interrupted || rl.line === "") {
      ctx.exit = true;
      rl.close();
      return;
    }
    interrupted = true;
    rl.write(null, { ctrl: true, name: "u" });
    out(`  ${ui.c.muted("(cleared — ^C again to quit)")}`);
    rl.prompt();
  });

  const drawPrompt = () => {
    if (settings.statusBar) {
      out(ui.statusBar({
        user: settings.userName,
        channel: channelName(ctx.session),
        model: settings.model || engine.config.CONVO_MODEL,
        pending: pending.attachments.length > 0
          ? [`📎 ${pending.attachments.length} queued`]
          : [],
      }));
    }
    rl.setPrompt(promptLabel(ctx.session));
    rl.prompt();
  };

  drawPrompt();

  // The async iterator, not rl.question(): readline pauses the input stream
  // while the body awaits, so a piped or fast-typed line that lands mid-turn is
  // queued rather than dropped.
  for await (const raw of rl) {
    const line = raw.trim();
    interrupted = false;
    if (line) {
      const handled = commands.dispatch(line, ctx);
      if (handled) {
        await handled;
      } else {
        try {
          await runTurn(ctx, line);
        } catch (err) {
          out("");
          for (const l of ui.embed({
            title: "Client error", description: err.message, color: "#ED4245",
          })) out(l);
        }
      }
    }
    if (ctx.exit) break;
    drawPrompt();
  }

  rl.close();
  out(`\n  ${ui.c.muted("Closing databases…")}`);
  store.close();
  engine.close();
  process.exit(0);
}

main();
