// Slash commands.
//
// Each command is a plain object with a handler receiving (ctx, args). `ctx`
// carries the mutable session state, the settings object, the store, the UI
// renderer, and the engine — nothing readline-specific beyond `out` and `send`,
// so a command could be driven from somewhere other than a terminal.
//
// The vocabulary is the one this project's ancestor used: channels, members,
// replies, attachments, pins, reactions, embeds. A session is a channel, a
// session title is a #channel-name, and the engine's conversationId is the
// channel id — which is why /join also moves the memory scope.
//
// Handlers may be async. Anything that sends a message (/reply, /retry, /me)
// returns the promise so the REPL does not draw its prompt over a reply in
// flight.

const fs = require("fs");
const path = require("path");
const settingsModule = require("./settings");
const contextModule = require("./context");

const COMMANDS = [];
function define(cmd) { COMMANDS.push(cmd); return cmd; }

function find(name) {
  const needle = String(name).toLowerCase();
  return COMMANDS.find(c => c.name === needle || (c.aliases || []).includes(needle));
}

// --- Shared helpers --------------------------------------------------------

function emit(ctx, lines) {
  for (const line of lines) ctx.out(line);
}

function channelOf(ctx, session = ctx.session) {
  return ctx.store.channelName(session.title || session.id);
}

function channelLabel(ctx, session) {
  return `#${channelOf(ctx, session)}`;
}

function ok(ctx, text) { ctx.out(`  ${ctx.ui.c.success("✓")} ${text}`); }
function warn(ctx, text) { ctx.out(`  ${ctx.ui.c.warn("!")} ${text}`); }
function fail(ctx, text) { ctx.out(`  ${ctx.ui.c.error("✗")} ${text}`); }

// Ordinals are what every message-scoped command takes, so they all need the
// same "did you actually give me one" check.
function requireRef(ctx, ref, usage) {
  if (!ref) { warn(ctx, `Usage: ${usage}`); return null; }
  const msg = ctx.store.messageByRef(ctx.session.id, ref);
  if (!msg) { fail(ctx, `No message ${ref} in ${channelLabel(ctx, ctx.session)}. Try /history.`); return null; }
  return msg;
}

function renderMessages(ctx, messages, opts = {}) {
  const ui = ctx.ui;
  const compact = opts.compact ?? ctx.settings.compact;

  // A reply renders its parent inline, the way a client shows the quoted line
  // above one. The parent is usually in the batch already; anything older is
  // fetched once into the same index rather than per message.
  const byMessageId = new Map(messages.map(m => [m.messageId, m]));
  const missing = messages.some(m => m.replyToId && !byMessageId.has(m.replyToId));
  if (missing && !compact) {
    for (const m of ctx.store.allMessages(ctx.session.id)) {
      if (!byMessageId.has(m.messageId)) byMessageId.set(m.messageId, m);
    }
  }

  let lastDay = null;
  for (const m of messages) {
    const day = ui.dayLabel(m.timestamp);
    if (day !== lastDay && !compact) {
      ctx.out(ui.rule("─", day));
      lastDay = day;
    }
    const parent = m.replyToId ? byMessageId.get(m.replyToId) : null;
    emit(ctx, ui.renderMessage(
      {
        ...m,
        replyTo: parent ? {
          name: parent.role === "assistant" ? ctx.settings.botName : parent.userName,
          text: parent.text,
          bot: parent.role === "assistant",
        } : null,
      },
      { compact, botName: ctx.settings.botName },
    ));
    if (!compact) ctx.out("");
  }
}

// --- Channels --------------------------------------------------------------

define({
  name: "help", aliases: ["h", "?"], usage: "/help [command]", group: "channel",
  description: "List every command, or explain one.",
  handler: (ctx, args) => {
    const ui = ctx.ui;

    if (args[0]) {
      const cmd = find(args[0].replace(/^\//, ""));
      if (!cmd) return fail(ctx, `No command "/${args[0]}".`);
      return emit(ctx, ui.embed({
        title: cmd.usage,
        description: cmd.description,
        fields: [
          { name: "group", value: cmd.group || "misc" },
          { name: "aliases", value: (cmd.aliases || []).map(a => `/${a}`).join(", ") || "—" },
          ...(cmd.detail ? [{ name: "notes", value: cmd.detail, block: true }] : []),
        ],
      }));
    }

    const GROUPS = [
      ["channel", "Channels"],
      ["message", "Messages"],
      ["member", "Members"],
      ["bot", "Bot"],
      ["config", "Configuration"],
    ];
    const fields = [];
    for (const [group, label] of GROUPS) {
      const inGroup = COMMANDS.filter(cmd => (cmd.group || "misc") === group);
      if (inGroup.length === 0) continue;
      if (fields.length > 0) fields.push({ divider: true });
      fields.push({ name: "", value: ui.c.bold(label) });
      for (const cmd of inGroup) fields.push({ name: cmd.usage, value: cmd.description });
    }
    emit(ctx, ui.embed({
      title: "Commands",
      description: "Anything not starting with `/` is sent to the model. `/help <command>` for detail.",
      fields,
      inlineWidth: 26,
      footer: "Tab completes commands, settings, and channel names.",
    }));
  },
});

define({
  name: "exit", aliases: ["quit", "q"], usage: "/exit", group: "channel",
  description: "Close databases and quit.",
  handler: (ctx) => { ctx.exit = true; },
});

define({
  name: "new", usage: "/new [title]", group: "channel",
  description: "Create a channel (new conversation + memory scope).",
  handler: (ctx, args) => {
    const session = ctx.store.createSession(args.join(" ").trim());
    ctx.setSession(session);
    ok(ctx, `Created ${ctx.ui.c.accent(channelLabel(ctx, session))} ${ctx.ui.c.muted(session.id)}`);
  },
});

define({
  name: "channels", aliases: ["sessions", "ls"], usage: "/channels", group: "channel",
  description: "List channels, most recently active first.",
  handler: (ctx) => {
    const ui = ctx.ui;
    const sessions = ctx.store.listSessions();
    if (sessions.length === 0) return warn(ctx, "No channels yet — /new to make one.");

    const inCharacter = ctx.store.contextSessionIds();
    const fields = sessions.map((s) => {
      const here = s.id === ctx.session.id;
      const name = `${here ? ui.c.accent("▸") : " "} ${here ? ui.c.accent(`#${channelOf(ctx, s)}`) : `#${channelOf(ctx, s)}`}`;
      const mask = inCharacter.has(s.id) ? ui.c.warn(" 🎭") : "";
      const meta = `${String(s.messageCount).padStart(4)} msgs   ${ui.padEndVisible(ui.ago(s.updatedAt), 10)} ${ui.c.muted(s.id)}${mask}`;
      return { name, value: meta };
    });
    emit(ctx, ui.embed({
      title: `Channels (${sessions.length})`,
      fields,
      inlineWidth: 26,
      footer: "/join <#channel|id> to switch",
    }));
  },
});

define({
  name: "join", aliases: ["switch", "use"], usage: "/join <#channel|id>", group: "channel",
  description: "Switch channel by name, id, or id prefix.",
  handler: (ctx, args) => {
    if (args.length === 0) return warn(ctx, "Usage: /join <#channel|id>");
    const session = ctx.store.resolveSession(args.join(" ").trim());
    if (!session) return fail(ctx, "No channel matches that.");
    ctx.setSession(session);
    ctx.showChannelHeader();
  },
});

define({
  name: "rename", usage: "/rename <title>", group: "channel",
  description: "Retitle this channel (its #name follows).",
  handler: (ctx, args) => {
    const title = args.join(" ").trim();
    if (!title) return warn(ctx, "Usage: /rename <title>");
    ctx.store.renameSession(ctx.session.id, title);
    ctx.session.title = title;
    ok(ctx, `Now ${ctx.ui.c.accent(channelLabel(ctx, ctx.session))}`);
  },
});

define({
  name: "topic", usage: "/topic [text|clear]", group: "channel",
  description: "Show or set the channel topic.",
  detail: "The topic is client-side: it appears in the channel header and in exports. What the engine infers as the conversation's topic is separate, and shown by /memory.",
  handler: (ctx, args) => {
    if (args.length === 0) {
      return ctx.out(`  ${ctx.session.topic ? ctx.ui.c.text(ctx.session.topic) : ctx.ui.c.muted("No topic set.")}`);
    }
    const topic = args.join(" ").trim();
    const next = (topic === "clear" || topic === "none") ? "" : topic;
    ctx.store.setTopic(ctx.session.id, next);
    ctx.session.topic = next;
    ok(ctx, next ? "Topic updated." : "Topic cleared.");
  },
});

// --- Roleplay context ------------------------------------------------------

function renderContext(ctx, context) {
  const ui = ctx.ui;
  const set = contextModule.isSet(context);

  emit(ctx, ui.embed({
    title: `Context — ${channelLabel(ctx, ctx.session)}`,
    description: set
      ? "The bot is in character in this channel. This replaces the persona for these turns."
      : "No character set here. `/context set <field> <text>` starts one.",
    fields: contextModule.FIELDS.map((f) => {
      const value = String(context[f.key] || "").trim();
      return {
        name: f.label,
        value: value || ui.c.muted(`(unset) ${f.describe}`),
        block: Boolean(value),
      };
    }),
    footer: set
      ? "/context clear [field] to remove · /context show to see the prompt"
      : `e.g. /context set personality ${contextModule.FIELDS[1].example}`,
  }));
}

define({
  name: "context", aliases: ["rp"], usage: "/context [set|clear|show] …", group: "channel",
  description: "Set a character for this channel — the per-channel roleplay context.",
  detail: [
    "Five fields describe a character: characteristics, personality, preferences, dialog, boundaries.",
    "",
    "  /context                     show what is set here",
    "  /context set <field> <text>  set one field",
    "  /context clear [field]       clear one field, or the whole character",
    "  /context show                print the exact persona the model receives",
    "",
    "Set on any field and the bot plays that character in this channel only, overriding /persona. Other channels are unaffected — that is the point of it being per-channel.",
    "",
    "The channel /topic, if set, is passed along as the character's background.",
  ].join("\n"),
  handler: (ctx, args) => {
    const ui = ctx.ui;
    const sub = (args[0] || "").toLowerCase();
    const context = ctx.store.getContext(ctx.session.id);

    if (!sub || sub === "get" || sub === "list") return renderContext(ctx, context);

    if (sub === "show") {
      const persona = contextModule.buildPersona(context, {
        channelName: channelOf(ctx),
        topic: ctx.session.topic,
      });
      if (!persona) return warn(ctx, "No character set here, so the engine default persona is used.");
      return emit(ctx, ui.embed({
        title: "Persona sent to the model",
        fields: persona.split("\n").map(line => ({ name: "", value: line || " " })),
        inlineWidth: 0,
        footer: "Passed as options.persona on every turn in this channel",
      }));
    }

    if (sub === "set") {
      const f = contextModule.field(args[1]);
      if (!f) {
        return warn(ctx, `Usage: /context set <${contextModule.KEYS.join("|")}> <text>`);
      }
      const value = contextModule.coerceValue(args.slice(2).join(" "));
      if (!value) return warn(ctx, `Usage: /context set ${f.key} <text>   (e.g. ${f.example})`);

      const before = contextModule.isSet(context);
      ctx.store.setContext(ctx.session.id, { [f.key]: value });
      ok(ctx, `${f.label} set.`);
      if (value.length === contextModule.MAX_FIELD_LENGTH) {
        warn(ctx, `Truncated to ${contextModule.MAX_FIELD_LENGTH} characters.`);
      }
      if (!before) {
        ctx.out(`  ${ui.c.muted(`The bot is now in character in ${channelLabel(ctx, ctx.session)}. /context to review.`)}`);
      }
      return undefined;
    }

    if (sub === "clear" || sub === "reset") {
      if (args[1]) {
        const f = contextModule.field(args[1]);
        if (!f) return fail(ctx, `No field "${args[1]}". One of: ${contextModule.KEYS.join(", ")}.`);
        ctx.store.clearContext(ctx.session.id, f.key);
        return ok(ctx, `${f.label} cleared.`);
      }
      if (!contextModule.isSet(context)) return warn(ctx, "Nothing to clear.");
      ctx.store.clearContext(ctx.session.id);
      ok(ctx, `Character cleared. ${channelLabel(ctx, ctx.session)} is back to the normal persona.`);
      return undefined;
    }

    return fail(ctx, `Unknown subcommand "${sub}". Try /context, /context set, /context clear, /context show.`);
  },
});

define({
  name: "delete", usage: "/delete <#channel|id>", group: "channel",
  description: "Delete a channel and its transcript.",
  handler: (ctx, args) => {
    if (args.length === 0) return warn(ctx, "Usage: /delete <#channel|id>");
    const session = ctx.store.resolveSession(args.join(" ").trim());
    if (!session) return fail(ctx, "No channel matches that.");

    ctx.store.deleteSession(session.id);
    ok(ctx, `Deleted ${channelLabel(ctx, session)}`);

    // Deleting the channel you are sitting in leaves nowhere to type, so land on
    // the next most recent one — or a fresh channel if that was the last.
    if (session.id === ctx.session.id) {
      ctx.setSession(ctx.store.latestSession() || ctx.store.createSession());
      ctx.showChannelHeader();
    }
  },
});

define({
  name: "clear", aliases: ["cls"], usage: "/clear", group: "channel",
  description: "Clear the screen, like clear(1). Nothing is deleted.",
  detail: "Wipes the visible screen and the scrollback, then reprints the channel header so you still know where you are. Ctrl-L does the lighter version — it repaints the screen but leaves the scrollback, exactly as it does in a shell.\n\nThis only affects what is on your terminal. To delete the transcript itself, use /purge.",
  handler: (ctx) => {
    if (!ctx.clearScreen()) return warn(ctx, "Not a terminal — there is no screen to clear.");
    ctx.showChannelHeader();
  },
});

define({
  name: "purge", usage: "/purge", group: "channel",
  description: "Delete every message in this channel's transcript.",
  detail: "This is the destructive one: it removes the stored messages, not just what is on screen. Engine memory is a separate thing again — /forget drops that.",
  handler: (ctx) => {
    const removed = ctx.store.clearMessages(ctx.session.id);
    ctx.session.messageCount = 0;
    ok(ctx, `Purged ${removed} messages from ${channelLabel(ctx, ctx.session)}.`);
    ctx.out(`  ${ctx.ui.c.muted("Engine memory for this conversation is unchanged — /forget does that.")}`);
  },
});

define({
  name: "export", usage: "/export [file]", group: "channel",
  description: "Write the transcript to Markdown (.json for raw records).",
  handler: (ctx, args) => {
    const messages = ctx.store.allMessages(ctx.session.id);
    if (messages.length === 0) return warn(ctx, "Nothing to export.");

    const target = path.resolve(process.cwd(), args[0] || `${channelOf(ctx)}.md`);
    let body;
    if (target.endsWith(".json")) {
      body = JSON.stringify({ session: ctx.session, messages }, null, 2);
    } else {
      const lines = [
        `# #${channelOf(ctx)}`,
        "",
        ...(ctx.session.topic ? [`> ${ctx.session.topic}`, ""] : []),
        `Channel \`${ctx.session.id}\` — ${messages.length} messages`,
        "",
      ];
      for (const m of messages) {
        const who = m.role === "assistant" ? ctx.settings.botName : (m.userName || "You");
        const marks = [
          m.pinned ? "📌" : null,
          m.editedAt ? "(edited)" : null,
        ].filter(Boolean).join(" ");
        lines.push(`### ${who} — ${new Date(m.timestamp).toLocaleString()}${marks ? ` ${marks}` : ""}`, "", m.text, "");
        for (const a of m.attachments || []) lines.push(`📎 [${a.name || a.url}](${a.url})`, "");
        if (m.reactions.length > 0) {
          lines.push(`_reactions: ${m.reactions.map(r => `${r.emoji} ${r.count}`).join("  ")}_`, "");
        }
        if (m.tools.length > 0) lines.push(`_tools: ${m.tools.join(", ")}_`, "");
      }
      body = lines.join("\n");
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body, "utf8");
    ok(ctx, `Wrote ${messages.length} messages to ${target}`);
  },
});

// --- Messages --------------------------------------------------------------

define({
  name: "history", aliases: ["log"], usage: "/history [n]", group: "message",
  description: "Replay the last n messages of this channel (default 20).",
  handler: (ctx, args) => {
    const n = Number(args[0]) > 0 ? Number(args[0]) : 20;
    const messages = ctx.store.lastMessages(ctx.session.id, n);
    if (messages.length === 0) return warn(ctx, "This channel is empty.");
    ctx.out("");
    renderMessages(ctx, messages);
  },
});

define({
  name: "search", aliases: ["find"], usage: "/search <text> [--all]", group: "message",
  description: "Search this channel's transcript (--all searches every channel).",
  handler: (ctx, args) => {
    const all = args.includes("--all");
    const query = args.filter(a => a !== "--all").join(" ").trim();
    if (!query) return warn(ctx, "Usage: /search <text> [--all]");

    const results = ctx.store.searchMessages(all ? null : ctx.session.id, query);
    if (results.length === 0) return warn(ctx, `No messages matching "${query}".`);
    ctx.out(ctx.ui.rule("─", `${results.length} match${results.length === 1 ? "" : "es"} for "${query}"`));
    renderMessages(ctx, results, { compact: true });
    ctx.out("");
  },
});

define({
  name: "reply", aliases: ["r"], usage: "/reply <n> <text>", group: "message",
  description: "Reply to message #n, quoting it for the model.",
  detail: "The quoted message is passed to the engine as replyContext, the same field the Discord host filled in when a user used the reply affordance.",
  handler: async (ctx, args) => {
    const target = requireRef(ctx, args[0], "/reply <n> <text>");
    if (!target) return;
    const text = args.slice(1).join(" ").trim();
    if (!text) return warn(ctx, "Usage: /reply <n> <text>");

    const who = target.role === "assistant" ? ctx.settings.botName : (target.userName || "someone");
    await ctx.send(text, {
      replyContext: `[Replying to ${who}]: ${target.text}`,
      replyToId: target.messageId,
    });
  },
});

define({
  name: "retry", aliases: ["regen"], usage: "/retry", group: "message",
  description: "Drop the last reply and ask again.",
  handler: async (ctx) => {
    const lastUser = ctx.store.lastMessageOfRole(ctx.session.id, "user");
    if (!lastUser) return warn(ctx, "Nothing to retry.");

    // Both sides of the last exchange go, so the transcript does not end up
    // holding two answers to one question — a retry replaces, it does not append.
    const lastReply = ctx.store.lastMessageOfRole(ctx.session.id, "assistant");
    if (lastReply && lastReply.id > lastUser.id) ctx.store.deleteMessage(ctx.session.id, lastReply.seq);
    ctx.store.deleteMessage(ctx.session.id, lastUser.seq);

    ctx.out(`  ${ctx.ui.c.muted(`↻ retrying: ${lastUser.text.slice(0, 60)}${lastUser.text.length > 60 ? "…" : ""}`)}`);
    await ctx.send(lastUser.text, {});
  },
});

define({
  name: "edit", usage: "/edit <n> <text>", group: "message",
  description: "Edit message #n in the transcript.",
  detail: "Editing rewrites history only — it does not re-run the turn. Use /retry for that. Edited messages are marked, and the new text is what future turns replay.",
  handler: (ctx, args) => {
    const target = requireRef(ctx, args[0], "/edit <n> <text>");
    if (!target) return;
    const text = args.slice(1).join(" ").trim();
    if (!text) return warn(ctx, "Usage: /edit <n> <text>");
    ctx.store.editMessage(ctx.session.id, target.seq, text);
    ok(ctx, `Edited #${target.seq}.`);
  },
});

define({
  name: "delmsg", aliases: ["rm"], usage: "/delmsg <n>", group: "message",
  description: "Delete message #n from the transcript.",
  handler: (ctx, args) => {
    const target = requireRef(ctx, args[0], "/delmsg <n>");
    if (!target) return;
    ctx.store.deleteMessage(ctx.session.id, target.seq);
    ctx.session.messageCount = Math.max(0, ctx.session.messageCount - 1);
    ok(ctx, `Deleted #${target.seq}. ${ctx.ui.c.muted("Later messages renumbered.")}`);
  },
});

define({
  name: "react", usage: "/react <n> <emoji>", group: "message",
  description: "Add or remove a reaction on message #n.",
  detail: "Reacting twice with the same emoji removes your reaction, as it does in a client. Reactions are stored with the transcript and shown by /history and /export.",
  handler: (ctx, args) => {
    const target = requireRef(ctx, args[0], "/react <n> <emoji>");
    if (!target) return;
    const emoji = args[1];
    if (!emoji) return warn(ctx, "Usage: /react <n> <emoji>");

    const updated = ctx.store.toggleReaction(ctx.session.id, target.seq, emoji, ctx.settings.userName);
    const line = ctx.ui.reactionLine(updated.reactions);
    ctx.out(line || `  ${ctx.ui.c.muted(`No reactions left on #${target.seq}.`)}`);
  },
});

define({
  name: "pin", usage: "/pin <n>", group: "message",
  description: "Pin message #n in this channel.",
  handler: (ctx, args) => {
    const target = requireRef(ctx, args[0], "/pin <n>");
    if (!target) return;
    ctx.store.setPinned(ctx.session.id, target.seq, true);
    ok(ctx, `Pinned #${target.seq}.`);
  },
});

define({
  name: "unpin", usage: "/unpin <n>", group: "message",
  description: "Remove the pin from message #n.",
  handler: (ctx, args) => {
    const target = requireRef(ctx, args[0], "/unpin <n>");
    if (!target) return;
    ctx.store.setPinned(ctx.session.id, target.seq, false);
    ok(ctx, `Unpinned #${target.seq}.`);
  },
});

define({
  name: "pins", usage: "/pins", group: "message",
  description: "List this channel's pinned messages.",
  handler: (ctx) => {
    const pinned = ctx.store.listPinned(ctx.session.id);
    if (pinned.length === 0) return warn(ctx, "No pinned messages. /pin <n> to add one.");
    ctx.out(ctx.ui.rule("─", `📌 ${pinned.length} pinned`));
    renderMessages(ctx, pinned, { compact: true });
    ctx.out("");
  },
});

define({
  name: "attach", usage: "/attach <path|url>", group: "message",
  description: "Queue a file or link to send with your next message.",
  detail: "Text files and web pages are read and passed to the engine as perception, alongside the attachment record itself — the same two-part shape the Discord host produced when someone dropped a file into a channel. /attach with no argument lists the queue; /attach clear empties it.",
  handler: async (ctx, args) => {
    const ui = ctx.ui;
    if (args.length === 0) {
      if (ctx.pending.attachments.length === 0) return warn(ctx, "Nothing queued.");
      return emit(ctx, ui.embed({
        title: `Queued attachments (${ctx.pending.attachments.length})`,
        fields: ctx.pending.attachments.map(a => ({
          name: a.name,
          value: `${a.contentType}${a.size ? ` · ${ui.formatBytes(a.size)}` : ""}`,
        })),
        footer: "Sent with your next message · /attach clear to discard",
      }));
    }

    const arg = args.join(" ").trim();
    if (arg === "clear" || arg === "none") {
      ctx.pending.attachments = [];
      return ok(ctx, "Attachment queue cleared.");
    }

    try {
      const attachment = await ctx.resolveAttachment(arg);
      ctx.pending.attachments.push(attachment);
      ok(ctx, `Attached ${ui.c.link(attachment.name)} ${ui.c.muted(`(${attachment.contentType}${attachment.size ? `, ${ui.formatBytes(attachment.size)}` : ""})`)}`);
      if (!attachment.perception) {
        ctx.out(`  ${ui.c.muted("No readable text — the model will only see the filename and type.")}`);
      }
    } catch (err) {
      fail(ctx, err.message);
    }
  },
});

define({
  name: "me", usage: "/me <action>", group: "message",
  description: "Send an action message, italicised.",
  handler: async (ctx, args) => {
    const action = args.join(" ").trim();
    if (!action) return warn(ctx, "Usage: /me <action>");
    await ctx.send(`*${ctx.settings.userName} ${action}*`, {});
  },
});

// --- Members ---------------------------------------------------------------

define({
  name: "members", aliases: ["who"], usage: "/members", group: "member",
  description: "List everyone who has spoken in this channel.",
  handler: (ctx) => {
    const ui = ctx.ui;
    const list = ctx.store.members(ctx.session.id);
    if (list.length === 0) return warn(ctx, "Nobody has spoken here yet.");

    const online = list.filter(m => !m.bot);
    emit(ctx, ui.embed({
      title: `Members — ${channelLabel(ctx, ctx.session)}`,
      fields: list.map((m) => {
        const dot = m.bot ? ui.c.bot("●") : ui.paint(ui.memberColor(m.userName), "●");
        const name = `${dot} ${m.bot ? ui.c.bot(m.userName) : ui.member(m.userName)}${m.userName === ctx.settings.userName ? ui.c.muted(" (you)") : ""}`;
        return {
          name,
          value: `${String(m.messages).padStart(4)} msgs   ${ui.padEndVisible(ui.ago(m.lastAt), 10)} ${ui.c.muted(m.userId)}`,
        };
      }),
      inlineWidth: 26,
      footer: `${online.length} human${online.length === 1 ? "" : "s"} · /user <name> to speak as someone else`,
    }));
  },
});

define({
  name: "user", aliases: ["nick"], usage: "/user [name]", group: "member",
  description: "Show or change who you are speaking as.",
  detail: "Memory is anchored on userId, so switching name also switches which user's facts the engine reads and writes. An id is derived from the name unless you set userId yourself with /set.",
  handler: (ctx, args) => {
    const ui = ctx.ui;
    if (args.length === 0) {
      return ctx.out(`  Speaking as ${ui.member(ctx.settings.userName)} ${ui.c.muted(`(${ctx.settings.userId})`)}`);
    }
    const name = args.join(" ").trim();
    ctx.settings.userName = name;
    ctx.settings.userId = `cli-${ctx.store.channelName(name)}`;
    ctx.saveSettings();
    ok(ctx, `Now speaking as ${ui.member(name)} ${ui.c.muted(`(${ctx.settings.userId})`)}`);
    ctx.out(`  ${ui.c.muted("The engine keeps separate facts per user id.")}`);
  },
});

define({
  name: "whois", usage: "/whois [name]", group: "member",
  description: "What the engine knows about a member.",
  handler: (ctx, args) => {
    const ui = ctx.ui;
    const name = args.join(" ").trim() || ctx.settings.userName;
    const list = ctx.store.members(ctx.session.id);
    const found = list.find(m => m.userName.toLowerCase() === name.toLowerCase());
    const userId = found ? found.userId : ctx.settings.userId;

    const user = ctx.engine.memory.store.getUser(userId);
    const facts = (user.facts || []).map(f => ({ name: f.key, value: String(f.value) }));

    emit(ctx, ui.embed({
      title: found ? `${found.userName}${found.bot ? " (bot)" : ""}` : name,
      description: found ? null : "Not seen in this channel — showing your own record.",
      color: ui.memberColor(name),
      fields: [
        { name: "user id", value: userId },
        ...(found ? [
          { name: "messages here", value: String(found.messages) },
          { name: "first seen", value: new Date(found.firstAt).toLocaleString() },
          { name: "last seen", value: ui.ago(found.lastAt) },
        ] : []),
        { divider: true },
        ...(facts.length > 0 ? facts : [{ name: "known facts", value: "(none yet)" }]),
      ],
    }));
  },
});

// --- Bot -------------------------------------------------------------------

define({
  name: "status", usage: "/status", group: "bot",
  description: "Bot presence: model, channel, uptime, spend.",
  handler: (ctx) => {
    const ui = ctx.ui;
    const totals = ctx.store.globalStats();
    const here = ctx.store.stats(ctx.session.id);
    const uptime = Math.floor((Date.now() - ctx.startedAt) / 1000);

    emit(ctx, ui.embed({
      title: `${ctx.settings.botName} ${ui.c.success("● online")}`,
      fields: [
        { name: "model", value: ctx.settings.model || `${ctx.engine.config.CONVO_MODEL} (engine default)` },
        {
          name: "persona",
          value: contextModule.isSet(ctx.store.getContext(ctx.session.id))
            ? `${ui.c.warn("in character")} ${ui.c.muted("(/context)")}`
            : (ctx.settings.persona ? "custom (/persona)" : "engine default"),
        },
        { name: "tools", value: ctx.settings.tools ? `${ctx.registry.definitions().length} available` : "disabled" },
        { name: "memory writes", value: ctx.settings.memory ? "on" : "off" },
        { name: "streaming", value: ctx.settings.stream ? "on" : "off" },
        { divider: true },
        { name: "channel", value: `${channelLabel(ctx, ctx.session)} — ${here.messages} messages, ${here.pinned} pinned` },
        { name: "speaking as", value: `${ctx.settings.userName} (${ctx.settings.userId})` },
        { name: "kb scope", value: ctx.settings.scopeId },
        { divider: true },
        { name: "uptime", value: `${Math.floor(uptime / 60)}m ${uptime % 60}s` },
        { name: "channels", value: String(totals.sessions) },
        { name: "messages (all)", value: String(totals.messages) },
        { name: "spend (all)", value: `$${(totals.cost || 0).toFixed(4)}` },
      ],
      footer: ui.hostLabel(),
    }));
  },
});

define({
  name: "tools", usage: "/tools", group: "bot",
  description: "List the tools available to the model this turn.",
  handler: (ctx) => {
    if (!ctx.settings.tools) return warn(ctx, "Tools are disabled — /set tools on.");
    const defs = ctx.registry.definitions().map((d) => {
      const fn = d.function || d;
      return { name: fn.name, value: fn.description };
    });
    emit(ctx, ctx.ui.embed({
      title: `Tools (${defs.length})`,
      fields: defs,
      inlineWidth: 22,
      footer: `max ${ctx.settings.toolDepth || ctx.engine.config.MAX_TOOL_DEPTH} iterations per turn`,
    }));
  },
});

define({
  name: "memory", usage: "/memory", group: "bot",
  description: "Show what the engine remembers for this channel and user.",
  handler: (ctx) => {
    const ui = ctx.ui;
    const convo = ctx.engine.memory.store.getConversation(ctx.session.id);
    const user = ctx.engine.memory.store.getUser(ctx.settings.userId);

    const section = (label, items, fmt) => {
      const fields = [{ name: "", value: ui.c.bold(label) }];
      if (!items || items.length === 0) return [...fields, { name: "", value: ui.c.muted("  (none)") }];
      return [...fields, ...items.map(i => ({ name: "", value: `  ${fmt(i)}` }))];
    };
    const fact = f => `${ui.c.text(f.key)} = ${f.value} ${ui.c.muted(`[${f.confidence || "?"}${f.reinforcedCount ? `, x${f.reinforcedCount}` : ""}]`)}`;
    const summary = s => (typeof s === "string" ? s : s.text || JSON.stringify(s));
    const directive = d => `${ui.c.muted(`(${d.id})`)} ${d.text} ${ui.c.muted(`[${d.source || "manual"}]`)}`;

    emit(ctx, ui.embed({
      title: `Memory — ${channelLabel(ctx, ctx.session)}`,
      description: convo.topic ? `Topic: ${convo.topic}` : "No topic inferred yet.",
      fields: [
        ...section("standing instructions", convo.directives, directive),
        { divider: true },
        ...section("channel facts", convo.facts, fact),
        { divider: true },
        ...section("summaries", convo.summaries, summary),
        { divider: true },
        ...section(`facts about ${ctx.settings.userName}`, user.facts, fact),
      ],
      inlineWidth: 0,
      footer: "/forget drops all of this for this channel",
    }));
  },
});

define({
  name: "forget", usage: "/forget", group: "bot",
  description: "Drop the engine's facts, summaries, and rules for this channel.",
  handler: (ctx) => {
    ctx.engine.memory.store.deleteConversation(ctx.session.id);
    ok(ctx, "Channel memory deleted (facts, summaries, participants, standing instructions).");
    ctx.out(`  ${ctx.ui.c.muted("The transcript itself is untouched — /purge does that.")}`);
  },
});

define({
  name: "stats", aliases: ["usage"], usage: "/stats", group: "bot",
  description: "Message count, tokens, and spend for this channel.",
  handler: (ctx) => {
    const ui = ctx.ui;
    const s = ctx.store.stats(ctx.session.id);
    const perReply = s.replies > 0 ? s.tokens / s.replies : 0;

    emit(ctx, ui.embed({
      title: `Stats — ${channelLabel(ctx, ctx.session)}`,
      fields: [
        { name: "channel id", value: ctx.session.id },
        { name: "messages", value: `${s.messages} (${s.replies} from the bot)` },
        { name: "pinned", value: String(s.pinned) },
        { name: "tokens", value: `${s.tokens}${perReply ? ui.c.muted(`  ~${Math.round(perReply)}/reply`) : ""}` },
        { name: "cost", value: `$${(s.cost || 0).toFixed(4)}` },
        { name: "started", value: s.firstAt ? new Date(s.firstAt).toLocaleString() : "—" },
        { name: "last active", value: s.lastAt ? ui.ago(s.lastAt) : "—" },
      ],
    }));
  },
});

// --- Configuration ---------------------------------------------------------

define({
  name: "config", aliases: ["settings"], usage: "/config", group: "config",
  description: "Show every setting and its current value.",
  handler: (ctx) => {
    const ui = ctx.ui;
    const grouped = settingsModule.GROUPS;
    const seen = new Set();
    const fields = [];

    const row = (key) => {
      const def = settingsModule.DEFINITIONS[key];
      seen.add(key);
      const value = settingsModule.format(ctx.settings[key]);
      const shown = value === "(default)" ? ui.c.muted(value) : ui.c.success(value);
      return { name: `  ${key}`, value: `${ui.padEndVisible(shown, 18)} ${ui.c.muted(def.describe)}${def.restart ? ui.c.warn(" ↻") : ""}` };
    };

    for (const [label, keys] of Object.entries(grouped)) {
      if (fields.length > 0) fields.push({ divider: true });
      fields.push({ name: "", value: ui.c.bold(label) });
      for (const key of keys) if (settingsModule.DEFINITIONS[key]) fields.push(row(key));
    }
    const rest = Object.keys(settingsModule.DEFINITIONS).filter(k => !seen.has(k));
    if (rest.length > 0) {
      fields.push({ divider: true }, { name: "", value: ui.c.bold("other") });
      for (const key of rest) fields.push(row(key));
    }

    emit(ctx, ui.embed({
      title: "Settings",
      description: "`/set <key> <value>` to change one; `default` restores the default.",
      fields,
      inlineWidth: 18,
      footer: `↻ = applied at startup, restart to take effect · ${settingsModule.SETTINGS_PATH}`,
    }));
  },
});

define({
  name: "set", usage: "/set <key> <value>", group: "config",
  description: "Change a setting. Value 'default' restores the default.",
  handler: (ctx, args) => {
    if (args.length < 2) return warn(ctx, "Usage: /set <key> <value>   (see /config)");
    const key = args[0];
    const def = settingsModule.DEFINITIONS[key];
    if (!def) return fail(ctx, `Unknown setting "${key}". See /config.`);

    ctx.settings[key] = settingsModule.coerce(key, args.slice(1).join(" "));
    ctx.saveSettings();
    ctx.applyAppearance();
    ok(ctx, `${key} = ${settingsModule.format(ctx.settings[key])}`);
    if (def.restart) warn(ctx, "This one only applies at startup — restart for it to take effect.");
  },
});

define({
  name: "theme", usage: "/theme [name]", group: "config",
  description: "Switch colour theme, or preview them all.",
  handler: (ctx, args) => {
    const ui = ctx.ui;
    if (args.length === 0) {
      const current = ctx.settings.theme;
      return emit(ctx, ui.embed({
        title: "Themes",
        fields: ui.themeNames().map(name => ({
          name: `${name === current ? ui.c.accent("▸") : " "} ${name}`,
          value: name === current ? ui.c.muted("current") : "",
        })),
        footer: "/theme <name>",
      }));
    }
    return find("set").handler(ctx, ["theme", ...args]);
  },
});

define({
  name: "persona", usage: "/persona [text|reset]", group: "config",
  description: "Show or override the system persona.",
  handler: (ctx, args) => {
    const ui = ctx.ui;
    if (args.length === 0) {
      return emit(ctx, ui.embed({
        title: "Persona",
        description: ctx.settings.persona || "(engine default)",
        footer: "/persona <text> to override · /persona reset to restore",
      }));
    }
    const text = args.join(" ").trim();
    ctx.settings.persona = (text === "reset" || text === "default") ? null : text;
    ctx.saveSettings();
    ok(ctx, ctx.settings.persona ? "Persona updated." : "Persona reset to the engine default.");
  },
});

define({
  name: "model", usage: "/model [name]", group: "config",
  description: "Show or set the chat model (restart to apply).",
  handler: (ctx, args) => {
    if (args.length === 0) {
      return ctx.out(`  ${ctx.ui.c.text(ctx.settings.model || `${ctx.engine.config.CONVO_MODEL} ${ctx.ui.c.muted("(engine default)")}`)}`);
    }
    return find("set").handler(ctx, ["model", ...args]);
  },
});

// --- Dispatch --------------------------------------------------------------

// Returns false when the line is ordinary text bound for the model, and a
// promise otherwise — resolved once the command (which may itself have sent a
// message) is finished, so the REPL can hold the prompt until then.
function dispatch(line, ctx) {
  if (!line.startsWith("/")) return false;

  const [name, ...args] = line.slice(1).split(/\s+/);
  const cmd = find(name);
  if (!cmd) {
    const guess = nearestCommand(name);
    ctx.out(`  ${ctx.ui.c.error("✗")} Unknown command "/${name}".${guess ? ` Did you mean ${ctx.ui.c.accent(`/${guess}`)}?` : " Try /help."}`);
    return Promise.resolve(true);
  }

  return Promise.resolve()
    .then(() => cmd.handler(ctx, args))
    .catch(err => ctx.out(`  ${ctx.ui.c.error("✗")} ${err.message}`))
    .then(() => true);
}

// Cheap nearest-name guess for a typo'd command: shared prefix, then substring.
function nearestCommand(name) {
  const needle = String(name).toLowerCase();
  if (!needle) return null;
  const names = COMMANDS.flatMap(c => [c.name, ...(c.aliases || [])]);
  return names.find(n => n.startsWith(needle.slice(0, 3)))
    || names.find(n => n.includes(needle))
    || null;
}

// --- Completion ------------------------------------------------------------

// What the live picker offers for a half-typed line: command names at the
// start, then per-command argument candidates.
//
// Returns { token, items } where `token` is the word being replaced — the
// caller rebuilds the line by swapping the last `token.length` characters for
// an item's `value`, which works the same whether that word is a command name
// or an argument. Null means "nothing to offer, hide the picker".
//
// Matching is prefix-first, then substring, so /pin finds `unpin` too. Ordering
// is by that same rule, because a picker that puts the exact prefix match
// second is worse than no picker.
function suggest(line, ctx) {
  if (!line.startsWith("/")) return null;

  // A trailing space already yields an empty final element, which is exactly
  // the "you are starting a new word" case.
  const parts = line.slice(1).split(/\s+/);
  const token = parts[parts.length - 1];
  const argIndex = parts.length - 1;

  if (argIndex === 0) {
    return { token, items: rank(commandItems(), token) };
  }

  const cmd = find(parts[0]);
  if (!cmd) return null;
  return { token, items: rank(argumentItems(cmd, parts, ctx), token) };
}

function commandItems() {
  return COMMANDS.map(c => ({ value: c.name, label: c.usage, hint: c.description }));
}

function argumentItems(cmd, parts, ctx) {
  const settingKeys = () => Object.keys(settingsModule.DEFINITIONS).map(key => ({
    value: key, label: key, hint: settingsModule.DEFINITIONS[key].describe,
  }));

  switch (cmd.name) {
    case "set":
      if (parts.length === 2) return settingKeys();
      if (parts.length === 3) {
        return settingsModule.valuesFor(parts[1]).map(v => ({
          value: v,
          label: v,
          hint: v === settingsModule.format(ctx.settings[parts[1]]) ? "current" : "",
        }));
      }
      return [];

    case "theme":
      return ctx.ui.themeNames().map(name => ({
        value: name, label: name, hint: name === ctx.settings.theme ? "current" : "",
      }));

    case "context": {
      if (parts.length === 2) {
        return [
          { value: "set", label: "set", hint: "Set one field of the character" },
          { value: "clear", label: "clear", hint: "Clear a field, or the whole character" },
          { value: "show", label: "show", hint: "Print the persona the model receives" },
        ];
      }
      // Both `set` and `clear` take a field name next; nothing else does.
      if (parts.length === 3 && ["set", "clear", "reset"].includes(parts[1].toLowerCase())) {
        const current = ctx.store.getContext(ctx.session.id);
        return contextModule.FIELDS.map(f => ({
          value: f.key,
          label: f.label,
          hint: String(current[f.key] || "").trim()
            ? `set — ${String(current[f.key]).slice(0, 40)}`
            : f.describe,
        }));
      }
      return [];
    }

    case "help":
      return commandItems();

    case "join": case "delete":
      return ctx.store.listSessions().map(s => ({
        value: `#${ctx.store.channelName(s.title || s.id)}`,
        label: `#${ctx.store.channelName(s.title || s.id)}`,
        hint: `${s.messageCount} messages · ${ctx.ui.ago(s.updatedAt)}`,
      }));

    case "user": case "whois":
      return ctx.store.members(ctx.session.id).map(m => ({
        value: m.userName,
        label: m.userName,
        hint: `${m.messages} messages${m.bot ? " · bot" : ""}`,
      }));

    // Message-scoped commands take an ordinal, so the useful thing to offer is
    // the recent messages themselves rather than a list of numbers.
    case "reply": case "edit": case "delmsg": case "react": case "pin": case "unpin":
      if (parts.length !== 2) return [];
      return ctx.store.lastMessages(ctx.session.id, 8).reverse().map(m => ({
        value: String(m.seq),
        label: `#${m.seq}`,
        hint: `${m.role === "assistant" ? ctx.settings.botName : m.userName}: ${m.text.replace(/\s+/g, " ").slice(0, 48)}`,
      }));

    default:
      return [];
  }
}

function rank(items, token) {
  const needle = token.toLowerCase();
  if (needle === "") return items;
  const starts = items.filter(i => i.value.toLowerCase().startsWith(needle));
  const contains = items.filter(
    i => !i.value.toLowerCase().startsWith(needle) && i.value.toLowerCase().includes(needle),
  );
  return [...starts, ...contains];
}

module.exports = { COMMANDS, dispatch, find, suggest };
