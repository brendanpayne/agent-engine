// Slash commands.
//
// Each command is a plain object with a handler receiving (ctx, args). `ctx`
// carries the mutable session state, the settings object, the store, and the
// engine — nothing readline-specific beyond `out`, so a command could be driven
// from somewhere other than a terminal.

const fs = require("fs");
const path = require("path");
const settingsModule = require("./settings");

const COMMANDS = [];
function define(cmd) { COMMANDS.push(cmd); return cmd; }

function find(name) {
  const needle = name.toLowerCase();
  return COMMANDS.find(c => c.name === needle || (c.aliases || []).includes(needle));
}

function sessionLabel(session) {
  return `${session.id}${session.title ? `  ${session.title}` : ""}`;
}

function ago(ts) {
  if (!ts) return "never";
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// --- Conversation ----------------------------------------------------------

define({
  name: "help", aliases: ["h", "?"], usage: "/help",
  description: "List every command.",
  handler: (ctx) => {
    ctx.out("\nCommands:");
    for (const cmd of COMMANDS) {
      ctx.out(`  ${cmd.usage.padEnd(24)} ${cmd.description}`);
    }
    ctx.out("\nAnything not starting with / is sent to the model.\n");
  },
});

define({
  name: "exit", aliases: ["quit", "q"], usage: "/exit",
  description: "Close databases and quit.",
  handler: (ctx) => { ctx.exit = true; },
});

define({
  name: "new", usage: "/new [title]",
  description: "Start a new session (new conversation + memory scope).",
  handler: (ctx, args) => {
    const session = ctx.store.createSession(args.join(" ").trim());
    ctx.setSession(session);
    ctx.out(`New session ${sessionLabel(session)}`);
  },
});

define({
  name: "sessions", aliases: ["ls"], usage: "/sessions",
  description: "List saved sessions, most recent first.",
  handler: (ctx) => {
    const sessions = ctx.store.listSessions();
    if (sessions.length === 0) return ctx.out("No sessions yet.");
    ctx.out("");
    for (const s of sessions) {
      const marker = s.id === ctx.session.id ? "*" : " ";
      ctx.out(`${marker} ${s.id}  ${String(s.messageCount).padStart(4)} msgs  ${ago(s.updatedAt).padEnd(10)} ${s.title}`);
    }
    ctx.out("");
  },
});

define({
  name: "switch", aliases: ["use"], usage: "/switch <id>",
  description: "Switch to another session by id, id prefix, or title.",
  handler: (ctx, args) => {
    if (args.length === 0) return ctx.out("Usage: /switch <id>");
    const session = ctx.store.resolveSession(args.join(" ").trim());
    if (!session) return ctx.out("No session matches that.");
    ctx.setSession(session);
    ctx.out(`Switched to ${sessionLabel(session)} (${session.messageCount} messages)`);
  },
});

define({
  name: "rename", usage: "/rename <title>",
  description: "Retitle the current session.",
  handler: (ctx, args) => {
    const title = args.join(" ").trim();
    if (!title) return ctx.out("Usage: /rename <title>");
    ctx.store.renameSession(ctx.session.id, title);
    ctx.session.title = title;
    ctx.out(`Renamed to "${title}"`);
  },
});

define({
  name: "delete", usage: "/delete <id>",
  description: "Delete a session and its transcript.",
  handler: (ctx, args) => {
    if (args.length === 0) return ctx.out("Usage: /delete <id>");
    const session = ctx.store.resolveSession(args.join(" ").trim());
    if (!session) return ctx.out("No session matches that.");

    ctx.store.deleteSession(session.id);
    ctx.out(`Deleted ${sessionLabel(session)}`);

    // Deleting the session you are sitting in leaves nowhere to type, so land
    // on the next most recent one — or a fresh session if that was the last.
    if (session.id === ctx.session.id) {
      const next = ctx.store.latestSession() || ctx.store.createSession();
      ctx.setSession(next);
      ctx.out(`Now in ${sessionLabel(next)}`);
    }
  },
});

define({
  name: "history", usage: "/history [n]",
  description: "Print the last n turns of this session (default 10).",
  handler: (ctx, args) => {
    const n = Number(args[0]) > 0 ? Number(args[0]) : 10;
    const messages = ctx.store.lastMessages(ctx.session.id, n * 2);
    if (messages.length === 0) return ctx.out("This session is empty.");
    ctx.out("");
    for (const m of messages) {
      const who = m.role === "assistant" ? "assistant" : (m.userName || "you");
      ctx.out(`[${new Date(m.timestamp).toLocaleTimeString()}] ${who}: ${m.text}`);
    }
    ctx.out("");
  },
});

define({
  name: "clear", usage: "/clear",
  description: "Erase this session's transcript (engine memory is untouched).",
  handler: (ctx) => {
    const removed = ctx.store.clearMessages(ctx.session.id);
    ctx.out(`Cleared ${removed} messages. Engine memory for this conversation is unchanged — use /forget for that.`);
  },
});

define({
  name: "forget", usage: "/forget",
  description: "Drop the engine's facts and summaries for this conversation.",
  handler: (ctx) => {
    ctx.engine.memory.store.deleteConversation(ctx.session.id);
    ctx.out("Conversation memory (facts, summaries, participants) deleted.");
  },
});

define({
  name: "export", usage: "/export [file]",
  description: "Write the transcript to Markdown (.json for raw records).",
  handler: (ctx, args) => {
    const messages = ctx.store.allMessages(ctx.session.id);
    if (messages.length === 0) return ctx.out("Nothing to export.");

    const target = path.resolve(process.cwd(), args[0] || `${ctx.session.id}.md`);
    let body;
    if (target.endsWith(".json")) {
      body = JSON.stringify({ session: ctx.session, messages }, null, 2);
    } else {
      const lines = [
        `# ${ctx.session.title || ctx.session.id}`,
        "",
        `Session \`${ctx.session.id}\` — ${messages.length} messages`,
        "",
      ];
      for (const m of messages) {
        const who = m.role === "assistant" ? "Assistant" : (m.userName || "You");
        lines.push(`### ${who} — ${new Date(m.timestamp).toLocaleString()}`, "", m.text, "");
        if (m.tools.length > 0) lines.push(`_tools: ${m.tools.join(", ")}_`, "");
      }
      body = lines.join("\n");
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body, "utf8");
    ctx.out(`Wrote ${messages.length} messages to ${target}`);
  },
});

// --- Configuration ---------------------------------------------------------

define({
  name: "config", aliases: ["settings"], usage: "/config",
  description: "Show every setting and its current value.",
  handler: (ctx) => {
    ctx.out("");
    for (const [key, def] of Object.entries(settingsModule.DEFINITIONS)) {
      const value = settingsModule.format(ctx.settings[key]);
      const note = def.restart ? " (restart)" : "";
      ctx.out(`  ${key.padEnd(14)} ${value.padEnd(16)} ${def.describe}${note}`);
    }
    ctx.out(`\n  stored in ${settingsModule.SETTINGS_PATH}`);
    ctx.out("  (restart) = applied to the engine at startup; reopen the CLI to take effect\n");
  },
});

define({
  name: "set", usage: "/set <key> <value>",
  description: "Change a setting. Value 'default' restores the default.",
  handler: (ctx, args) => {
    if (args.length < 2) return ctx.out("Usage: /set <key> <value>   (see /config)");
    const key = args[0];
    const def = settingsModule.DEFINITIONS[key];
    if (!def) return ctx.out(`Unknown setting "${key}". See /config.`);

    ctx.settings[key] = settingsModule.coerce(key, args.slice(1).join(" "));
    ctx.saveSettings();
    ctx.out(`${key} = ${settingsModule.format(ctx.settings[key])}`);
    if (def.restart) ctx.out("This one only applies at startup — restart the CLI for it to take effect.");
  },
});

define({
  name: "persona", usage: "/persona [text|reset]",
  description: "Show or override the system persona.",
  handler: (ctx, args) => {
    if (args.length === 0) {
      return ctx.out(ctx.settings.persona
        ? `Persona: ${ctx.settings.persona}`
        : "Persona: (engine default)");
    }
    const text = args.join(" ").trim();
    ctx.settings.persona = (text === "reset" || text === "default") ? null : text;
    ctx.saveSettings();
    ctx.out(ctx.settings.persona ? "Persona updated." : "Persona reset to the engine default.");
  },
});

define({
  name: "model", usage: "/model [name]",
  description: "Show or set the chat model (restart to apply).",
  handler: (ctx, args) => {
    if (args.length === 0) {
      return ctx.out(`Model: ${ctx.settings.model || `${ctx.engine.config.CONVO_MODEL} (engine default)`}`);
    }
    return find("set").handler(ctx, ["model", ...args]);
  },
});

// --- Inspection ------------------------------------------------------------

define({
  name: "tools", usage: "/tools",
  description: "List the tools available to the model this turn.",
  handler: (ctx) => {
    if (!ctx.settings.tools) return ctx.out("Tools are disabled (/set tools on).");
    const defs = ctx.registry.definitions();
    ctx.out("");
    for (const d of defs) {
      const fn = d.function || d;
      ctx.out(`  ${fn.name.padEnd(20)} ${fn.description}`);
    }
    ctx.out("");
  },
});

define({
  name: "memory", usage: "/memory",
  description: "Show what the engine remembers for this conversation and user.",
  handler: (ctx) => {
    const convo = ctx.engine.memory.store.getConversation(ctx.session.id);
    const user = ctx.engine.memory.store.getUser(ctx.settings.userId);

    ctx.out("");
    ctx.out(`  topic: ${convo.topic || "(none yet)"}`);

    const render = (label, items, fmt) => {
      ctx.out(`  ${label}: ${items.length === 0 ? "(none)" : ""}`);
      for (const item of items) ctx.out(`    - ${fmt(item)}`);
    };
    const fact = f => `${f.key} = ${f.value}` +
      `  [${f.confidence || "?"}${f.reinforcedCount ? `, x${f.reinforcedCount}` : ""}]`;
    const summary = s => (typeof s === "string" ? s : s.text || JSON.stringify(s));

    render("conversation facts", convo.facts || [], fact);
    render("conversation summaries", convo.summaries || [], summary);
    render("user facts", user.facts || [], fact);
    ctx.out("");
  },
});

define({
  name: "stats", aliases: ["usage"], usage: "/stats",
  description: "Message count, tokens, and spend for this session.",
  handler: (ctx) => {
    const s = ctx.store.stats(ctx.session.id);
    ctx.out("");
    ctx.out(`  session   ${sessionLabel(ctx.session)}`);
    ctx.out(`  messages  ${s.messages}`);
    ctx.out(`  tokens    ${s.tokens}`);
    ctx.out(`  cost      $${(s.cost || 0).toFixed(4)}`);
    ctx.out(`  started   ${s.firstAt ? new Date(s.firstAt).toLocaleString() : "—"}`);
    ctx.out("");
  },
});

// Returns true when the line was a command (handled or rejected), false when it
// is ordinary text bound for the model.
function dispatch(line, ctx) {
  if (!line.startsWith("/")) return false;

  const [name, ...args] = line.slice(1).split(/\s+/);
  const cmd = find(name);
  if (!cmd) {
    ctx.out(`Unknown command "/${name}". Try /help.`);
    return true;
  }

  try {
    cmd.handler(ctx, args);
  } catch (err) {
    ctx.out(`[error] ${err.message}`);
  }
  return true;
}

module.exports = { COMMANDS, dispatch, find };
