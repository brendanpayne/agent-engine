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

const { openDatabase } = require("../src/util/db");
const config = require("../config.js");

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL DEFAULT '',
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
    created_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
`;

let _db = null;
function db() {
  if (!_db) {
    const path = process.env.CLI_DB_PATH || `${config.DB_DIR}/cli_chat.sqlite`;
    _db = openDatabase(path, SCHEMA, "CLI");
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
  return { id, title, createdAt: now, updatedAt: now, messageCount: 0 };
}

function sessionRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    title: r.title,
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

// Session ids are long enough to be annoying to retype, so a unique prefix or a
// case-insensitive title match resolves too. An ambiguous prefix is an error
// rather than a guess — switching to the wrong conversation silently would mix
// two memory scopes.
function resolveSession(ref) {
  const exact = getSession(ref);
  if (exact) return exact;

  const needle = ref.toLowerCase();
  const matches = listSessions(500).filter(
    s => s.id.toLowerCase().startsWith(needle) || s.title.toLowerCase() === needle,
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`"${ref}" matches ${matches.length} sessions; use the full id.`);
  }
  return null;
}

function renameSession(id, title) {
  db().prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?")
    .run(title, Date.now(), id);
}

function deleteSession(id) {
  const tx = db().transaction(() => {
    db().prepare("DELETE FROM messages WHERE session_id = ?").run(id);
    db().prepare("DELETE FROM sessions WHERE id = ?").run(id);
  });
  tx();
}

function appendMessage({
  sessionId, messageId, role, userId = "", userName = "",
  text, tokens = 0, costUsd = 0, tools = [],
}) {
  const now = Date.now();
  const tx = db().transaction(() => {
    db().prepare(`
      INSERT INTO messages
        (session_id, message_id, role, user_id, user_name, text, tokens, cost_usd, tools, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, messageId, role, userId, userName, text,
      Math.round(tokens) || 0, costUsd || 0, JSON.stringify(tools), now);

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

function messageRow(r) {
  return {
    id: r.id,
    messageId: r.message_id,
    role: r.role,
    userId: r.user_id,
    userName: r.user_name,
    text: r.text,
    tokens: r.tokens,
    costUsd: r.cost_usd,
    tools: JSON.parse(r.tools || "[]"),
    timestamp: r.created_at,
  };
}

function allMessages(sessionId, limit = 1000) {
  return db().prepare(
    "SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT ?",
  ).all(sessionId, limit).map(messageRow);
}

function lastMessages(sessionId, limit) {
  return db().prepare(
    "SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?",
  ).all(sessionId, limit).map(messageRow).reverse();
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
           MIN(created_at) AS first_at,
           MAX(created_at) AS last_at
    FROM messages WHERE session_id = ?
  `).get(sessionId);
  return {
    messages: row.messages,
    tokens: row.tokens,
    cost: row.cost,
    firstAt: row.first_at,
    lastAt: row.last_at,
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
  renameSession, deleteSession,
  appendMessage, allMessages, lastMessages, historyForEngine, clearMessages,
  stats, close,
};
