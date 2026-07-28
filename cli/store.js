// Chat history for the CLI.
//
// The engine keeps *derived* memory — facts, summaries, episodes, an archive of
// message chunks. None of that is a transcript you can scroll, and the archive
// prunes on a retention policy. So the CLI owns its own verbatim log: one
// SQLite file, sessions and messages, opened with the same pragmas as every
// other store in the project.
//
// Session ids double as the engine's `conversationId`, which is what makes a
// `/switch` also switch memory scope.

const { openDatabase, addColumnIfMissing } = require("../src/util/db");
const config = require("../config.js");

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL DEFAULT '',
    topic       TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    message_id  TEXT NOT NULL,
    role        TEXT NOT NULL,
    user_id     TEXT NOT NULL DEFAULT '',
    user_name   TEXT NOT NULL DEFAULT '',
    text        TEXT NOT NULL,
    tokens      INTEGER NOT NULL DEFAULT 0,
    cost_usd    REAL NOT NULL DEFAULT 0,
    tools       TEXT NOT NULL DEFAULT '[]',
    attachments TEXT NOT NULL DEFAULT '[]',
    reactions   TEXT NOT NULL DEFAULT '[]',
    reply_to    TEXT NOT NULL DEFAULT '',
    pinned      INTEGER NOT NULL DEFAULT 0,
    edited_at   INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);

  CREATE TABLE IF NOT EXISTS contexts (
    session_id      TEXT PRIMARY KEY,
    characteristics TEXT NOT NULL DEFAULT '',
    personality     TEXT NOT NULL DEFAULT '',
    preferences     TEXT NOT NULL DEFAULT '',
    dialog          TEXT NOT NULL DEFAULT '',
    boundaries      TEXT NOT NULL DEFAULT '',
    updated_at      INTEGER NOT NULL
  );
`;

// Columns added after the first release. CREATE TABLE IF NOT EXISTS is a no-op
// on a database that already has the table, so an existing db/cli_chat.sqlite
// would never see them without this.
const MIGRATIONS = [
  ["sessions", "topic", "TEXT NOT NULL DEFAULT ''"],
  ["messages", "attachments", "TEXT NOT NULL DEFAULT '[]'"],
  ["messages", "reactions", "TEXT NOT NULL DEFAULT '[]'"],
  ["messages", "reply_to", "TEXT NOT NULL DEFAULT ''"],
  ["messages", "pinned", "INTEGER NOT NULL DEFAULT 0"],
  ["messages", "edited_at", "INTEGER NOT NULL DEFAULT 0"],
];

// Indexes over migrated columns cannot live in SCHEMA: openDatabase execs that
// string in full before anything else runs, so on a database created by an
// earlier version the index would reference a column that is still one
// statement away from existing.
const POST_MIGRATION_SCHEMA = `
  CREATE INDEX IF NOT EXISTS idx_messages_pinned ON messages(session_id, pinned);
`;

let _db = null;
function db() {
  if (!_db) {
    const path = process.env.CLI_DB_PATH || `${config.DB_DIR}/cli_chat.sqlite`;
    _db = openDatabase(path, SCHEMA, "CLI");
    for (const [table, column, definition] of MIGRATIONS) {
      addColumnIfMissing(_db, table, column, definition);
    }
    _db.exec(POST_MIGRATION_SCHEMA);
  }
  return _db;
}

function newId() {
  return `s_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

function createSession(title = "") {
  const now = Date.now();
  const id = newId();
  db().prepare(
    "INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
  ).run(id, title, now, now);
  return { id, title, topic: "", createdAt: now, updatedAt: now, messageCount: 0 };
}

function sessionRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    title: r.title,
    topic: r.topic || "",
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    messageCount: r.message_count ?? 0,
  };
}

const SESSION_SELECT = `
  SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
  FROM sessions s
`;

function listSessions(limit = 50) {
  return db().prepare(`${SESSION_SELECT} ORDER BY s.updated_at DESC LIMIT ?`)
    .all(limit).map(sessionRow);
}

function getSession(id) {
  return sessionRow(db().prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(id));
}

function latestSession() {
  return sessionRow(db().prepare(`${SESSION_SELECT} ORDER BY s.updated_at DESC LIMIT 1`).get());
}

// Session ids are long enough to be annoying to retype, so a unique prefix, a
// case-insensitive title, or the #channel-name form of the title resolves too.
// An ambiguous prefix is an error rather than a guess — switching to the wrong
// conversation silently would mix two memory scopes.
function resolveSession(ref) {
  const cleaned = String(ref).trim().replace(/^#/, "");
  const exact = getSession(cleaned);
  if (exact) return exact;

  const needle = cleaned.toLowerCase();
  const slug = channelName(needle);
  const matches = listSessions(500).filter(
    s => s.id.toLowerCase().startsWith(needle)
      || s.title.toLowerCase() === needle
      || channelName(s.title || s.id) === slug,
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`"${ref}" matches ${matches.length} sessions; use the full id.`);
  }
  return null;
}

// The #channel form of a session. Kept here rather than in the UI layer because
// resolveSession has to agree with whatever the user sees printed.
function channelName(text) {
  return String(text || "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "channel";
}

function renameSession(id, title) {
  db().prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?")
    .run(title, Date.now(), id);
}

function setTopic(id, topic) {
  db().prepare("UPDATE sessions SET topic = ?, updated_at = ? WHERE id = ?")
    .run(topic, Date.now(), id);
}

function deleteSession(id) {
  const tx = db().transaction(() => {
    db().prepare("DELETE FROM messages WHERE session_id = ?").run(id);
    db().prepare("DELETE FROM contexts WHERE session_id = ?").run(id);
    db().prepare("DELETE FROM sessions WHERE id = ?").run(id);
  });
  tx();
}

// --- Roleplay context ------------------------------------------------------
//
// One row per channel, holding the character fields defined in cli/context.js.
// Absent means "no character set", which reads the same as every field blank —
// so getContext always returns a full row and callers never branch on null.

const CONTEXT_FIELDS = ["characteristics", "personality", "preferences", "dialog", "boundaries"];

function contextRow(r) {
  const out = {};
  for (const key of CONTEXT_FIELDS) out[key] = r?.[key] || "";
  out.updatedAt = r?.updated_at || 0;
  return out;
}

function getContext(sessionId) {
  return contextRow(db().prepare("SELECT * FROM contexts WHERE session_id = ?").get(sessionId));
}

// Patch semantics: only the keys present are written, so setting one field
// cannot silently blank the other four.
function setContext(sessionId, patch) {
  const current = getContext(sessionId);
  const next = { ...current };
  for (const key of CONTEXT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) next[key] = String(patch[key] ?? "");
  }

  db().prepare(`
    INSERT INTO contexts (session_id, characteristics, personality, preferences, dialog, boundaries, updated_at)
    VALUES (@session_id, @characteristics, @personality, @preferences, @dialog, @boundaries, @updated_at)
    ON CONFLICT(session_id) DO UPDATE SET
      characteristics = excluded.characteristics,
      personality     = excluded.personality,
      preferences     = excluded.preferences,
      dialog          = excluded.dialog,
      boundaries      = excluded.boundaries,
      updated_at      = excluded.updated_at
  `).run({
    session_id: sessionId,
    characteristics: next.characteristics,
    personality: next.personality,
    preferences: next.preferences,
    dialog: next.dialog,
    boundaries: next.boundaries,
    updated_at: Date.now(),
  });

  return getContext(sessionId);
}

// Clearing one field is a patch; clearing everything drops the row, so a
// cleared channel is indistinguishable from one that never had a character.
function clearContext(sessionId, key = null) {
  if (key) return setContext(sessionId, { [key]: "" });
  db().prepare("DELETE FROM contexts WHERE session_id = ?").run(sessionId);
  return getContext(sessionId);
}

// Which channels have a character set — for listings, so a roleplay channel is
// visible as one without opening it.
function contextSessionIds() {
  const rows = db().prepare(`
    SELECT session_id FROM contexts
    WHERE TRIM(characteristics || personality || preferences || dialog || boundaries) <> ''
  `).all();
  return new Set(rows.map(r => r.session_id));
}

function appendMessage({
  sessionId, messageId, role, userId = "", userName = "",
  text, tokens = 0, costUsd = 0, tools = [], attachments = [], replyTo = "",
}) {
  const now = Date.now();
  const tx = db().transaction(() => {
    db().prepare(`
      INSERT INTO messages
        (session_id, message_id, role, user_id, user_name, text, tokens, cost_usd,
         tools, attachments, reply_to, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, messageId, role, userId, userName, text,
      Math.round(tokens) || 0, costUsd || 0, JSON.stringify(tools),
      JSON.stringify(attachments), replyTo || "", now);

    // An untitled session takes its title from the first thing said in it.
    db().prepare(`
      UPDATE sessions
      SET updated_at = ?,
          title = CASE WHEN title = '' AND ? = 'user' THEN ? ELSE title END
      WHERE id = ?
    `).run(now, role, text.slice(0, 60).replace(/\s+/g, " ").trim(), sessionId);
  });
  tx();
}

function safeParse(json, fallback) {
  try { return JSON.parse(json); } catch (_) { return fallback; }
}

function messageRow(r) {
  return {
    id: r.id,
    seq: r.seq,
    messageId: r.message_id,
    role: r.role,
    userId: r.user_id,
    userName: r.user_name,
    text: r.text,
    tokens: r.tokens,
    costUsd: r.cost_usd,
    tools: safeParse(r.tools, []),
    attachments: safeParse(r.attachments, []),
    reactions: safeParse(r.reactions, []),
    replyToId: r.reply_to || "",
    pinned: Boolean(r.pinned),
    editedAt: r.edited_at || 0,
    timestamp: r.created_at,
  };
}

// Every read goes through this so messages carry a per-session ordinal. That
// number is what the user types at /pin, /react, /reply and /edit — an
// autoincrement id is global and would make #1 belong to a different channel.
const MESSAGE_SELECT = `
  SELECT *, ROW_NUMBER() OVER (ORDER BY id) AS seq
  FROM messages WHERE session_id = ?
`;

function allMessages(sessionId, limit = 1000) {
  return db().prepare(`${MESSAGE_SELECT} ORDER BY id ASC LIMIT ?`)
    .all(sessionId, limit).map(messageRow);
}

function lastMessages(sessionId, limit) {
  return db().prepare(`SELECT * FROM (${MESSAGE_SELECT}) ORDER BY seq DESC LIMIT ?`)
    .all(sessionId, limit).map(messageRow).reverse();
}

// Resolve a user-facing reference to one message: a bare ordinal (#12), or a
// negative offset from the end (-1 is the most recent).
function messageByRef(sessionId, ref) {
  const n = Number(String(ref).replace(/^#/, ""));
  if (!Number.isInteger(n) || n === 0) return null;
  if (n > 0) {
    const row = db().prepare(`SELECT * FROM (${MESSAGE_SELECT}) WHERE seq = ?`).get(sessionId, n);
    return row ? messageRow(row) : null;
  }
  const rows = lastMessages(sessionId, Math.abs(n));
  return rows.length >= Math.abs(n) ? rows[0] : null;
}

function lastMessageOfRole(sessionId, role) {
  const row = db().prepare(
    `SELECT * FROM (${MESSAGE_SELECT}) WHERE role = ? ORDER BY seq DESC LIMIT 1`,
  ).get(sessionId, role);
  return row ? messageRow(row) : null;
}

// Substring search. LIKE with an escaped pattern rather than FTS: transcripts
// here are thousands of rows, not millions, and this keeps the schema plain.
function searchMessages(sessionId, query, limit = 25) {
  const pattern = `%${String(query).replace(/[\\%_]/g, ch => `\\${ch}`)}%`;
  const sql = sessionId
    ? `SELECT * FROM (${MESSAGE_SELECT}) WHERE text LIKE ? ESCAPE '\\' ORDER BY seq DESC LIMIT ?`
    : "SELECT *, 0 AS seq FROM messages WHERE text LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?";
  const args = sessionId ? [sessionId, pattern, limit] : [pattern, limit];
  return db().prepare(sql).all(...args).map(messageRow).reverse();
}

// One reaction per emoji, carrying who added it — the same shape Discord
// returns, and enough to toggle a user's own reaction off again.
function toggleReaction(sessionId, ref, emoji, userName) {
  const msg = messageByRef(sessionId, ref);
  if (!msg) return null;

  const reactions = msg.reactions.slice();
  const existing = reactions.find(r => r.emoji === emoji);
  if (!existing) {
    reactions.push({ emoji, count: 1, users: [userName] });
  } else if (existing.users.includes(userName)) {
    existing.users = existing.users.filter(u => u !== userName);
    existing.count = existing.users.length;
  } else {
    existing.users.push(userName);
    existing.count = existing.users.length;
  }

  const kept = reactions.filter(r => r.count > 0);
  db().prepare("UPDATE messages SET reactions = ? WHERE id = ?")
    .run(JSON.stringify(kept), msg.id);
  return { ...msg, reactions: kept };
}

function setPinned(sessionId, ref, pinned) {
  const msg = messageByRef(sessionId, ref);
  if (!msg) return null;
  db().prepare("UPDATE messages SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, msg.id);
  return { ...msg, pinned };
}

function listPinned(sessionId) {
  return db().prepare(`SELECT * FROM (${MESSAGE_SELECT}) WHERE pinned = 1 ORDER BY seq ASC`)
    .all(sessionId).map(messageRow);
}

function editMessage(sessionId, ref, text) {
  const msg = messageByRef(sessionId, ref);
  if (!msg) return null;
  db().prepare("UPDATE messages SET text = ?, edited_at = ? WHERE id = ?")
    .run(text, Date.now(), msg.id);
  return { ...msg, text, editedAt: Date.now() };
}

// Deleting by ordinal renumbers everything after it, which is exactly what a
// client does when a message disappears from a channel.
function deleteMessage(sessionId, ref) {
  const msg = messageByRef(sessionId, ref);
  if (!msg) return null;
  db().prepare("DELETE FROM messages WHERE id = ?").run(msg.id);
  return msg;
}

// The member list: everyone who has spoken in this channel, with how much and
// how recently, newest talker first.
function members(sessionId) {
  return db().prepare(`
    SELECT user_id, user_name, role,
           COUNT(*) AS messages,
           MIN(created_at) AS first_at,
           MAX(created_at) AS last_at
    FROM messages WHERE session_id = ?
    GROUP BY user_id, user_name
    ORDER BY last_at DESC
  `).all(sessionId).map(r => ({
    userId: r.user_id,
    userName: r.user_name,
    bot: r.role === "assistant",
    messages: r.messages,
    firstAt: r.first_at,
    lastAt: r.last_at,
  }));
}

// The engine expects history newest-first, in its own normalized shape.
function historyForEngine(sessionId, limit) {
  return db().prepare(
    "SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?",
  ).all(sessionId, limit).map(messageRow).map(m => ({
    userId: m.role === "assistant" ? "agent" : m.userId,
    userName: m.role === "assistant" ? "Assistant" : m.userName,
    text: m.text,
    messageId: m.messageId,
    timestamp: m.timestamp,
    isAgent: m.role === "assistant",
  }));
}

function clearMessages(sessionId) {
  const info = db().prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
  return info.changes;
}

function stats(sessionId) {
  const row = db().prepare(`
    SELECT COUNT(*) AS messages,
           COALESCE(SUM(tokens), 0) AS tokens,
           COALESCE(SUM(cost_usd), 0) AS cost,
           COALESCE(SUM(role = 'assistant'), 0) AS replies,
           COALESCE(SUM(pinned), 0) AS pinned,
           MIN(created_at) AS first_at,
           MAX(created_at) AS last_at
    FROM messages WHERE session_id = ?
  `).get(sessionId);
  return {
    messages: row.messages,
    replies: row.replies,
    pinned: row.pinned,
    tokens: row.tokens,
    cost: row.cost,
    firstAt: row.first_at,
    lastAt: row.last_at,
  };
}

// Totals across every channel, for the /status card.
function globalStats() {
  const row = db().prepare(`
    SELECT COUNT(*) AS messages,
           COALESCE(SUM(tokens), 0) AS tokens,
           COALESCE(SUM(cost_usd), 0) AS cost,
           (SELECT COUNT(*) FROM sessions) AS sessions
    FROM messages
  `).get();
  return {
    messages: row.messages, tokens: row.tokens, cost: row.cost, sessions: row.sessions,
  };
}

function close() {
  if (_db) {
    _db.pragma("wal_checkpoint(TRUNCATE)");
    _db.close();
    _db = null;
  }
}

module.exports = {
  createSession, listSessions, getSession, latestSession, resolveSession,
  renameSession, setTopic, deleteSession, channelName,
  getContext, setContext, clearContext, contextSessionIds,
  appendMessage, allMessages, lastMessages, messageByRef, lastMessageOfRole,
  searchMessages, toggleReaction, setPinned, listPinned, editMessage, deleteMessage,
  members, historyForEngine, clearMessages,
  stats, globalStats, close,
};
