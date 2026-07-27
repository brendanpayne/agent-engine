// Persistence for the memory tiers: per-conversation context and per-user
// profiles.
//
// Facts, summaries, and participants are stored as JSON columns rather than
// normalized tables. That is deliberate — they are always read and written as a
// whole set under a lock, never queried by individual row, so normalizing would
// add joins and migrations for no gain. The fact-scoring logic in facts.js
// operates on plain arrays and stays storage-agnostic as a result.
//
// Every mutation is a locked read-modify-write. Two concurrent turns in the
// same conversation will otherwise clobber each other's fact merges.

const config = require("../../config.js");
const logger = require("../util/logger");
const { withLock } = require("../util/lock");
const { openDatabase, addColumnIfMissing } = require("../util/db");

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS conversations (
    id                       TEXT PRIMARY KEY,
    name                     TEXT,
    topic                    TEXT NOT NULL DEFAULT '',
    summaries                TEXT NOT NULL DEFAULT '[]',
    facts                    TEXT NOT NULL DEFAULT '[]',
    directives               TEXT NOT NULL DEFAULT '[]',
    participants             TEXT NOT NULL DEFAULT '{}',
    persona                  TEXT,
    reset_point              TEXT,
    messages_since_summary   INTEGER NOT NULL DEFAULT 0,
    messages_since_facts     INTEGER NOT NULL DEFAULT 0,
    messages_since_topic     INTEGER NOT NULL DEFAULT 0,
    created_at               INTEGER NOT NULL,
    updated_at               INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_memory (
    user_id                  TEXT PRIMARY KEY,
    summaries                TEXT NOT NULL DEFAULT '[]',
    facts                    TEXT NOT NULL DEFAULT '[]',
    message_count            INTEGER NOT NULL DEFAULT 0,
    messages_since_summary   INTEGER NOT NULL DEFAULT 0,
    messages_since_facts     INTEGER NOT NULL DEFAULT 0,
    incognito                INTEGER NOT NULL DEFAULT 0,
    incognito_conversations  TEXT NOT NULL DEFAULT '[]',
    created_at               INTEGER NOT NULL,
    updated_at               INTEGER NOT NULL
  );
`;

let _db = null;
function openDb() {
  if (!_db) {
    _db = openDatabase(process.env.MEMORY_TEST_DB || config.MEMORY_DB_PATH, SCHEMA, "Memory");
    // Databases created before standing directives existed keep their old
    // conversations table; the schema above would not touch it.
    if (addColumnIfMissing(_db, "conversations", "directives", "TEXT NOT NULL DEFAULT '[]'")) {
      logger.info("[Memory] Migrated conversations table: added directives column.");
    }
  }
  return _db;
}

// A corrupt JSON column must not take down a turn. Log and fall back to the
// empty value so the conversation continues with degraded memory.
function parseJson(raw, fallback, label) {
  if (raw === null || raw === undefined) return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    logger.warn(`[Memory] Corrupt JSON in ${label}, resetting: ${err.message}`);
    return fallback;
  }
}

function defaultConversation(id, name = null) {
  return {
    id,
    name,
    topic: "",
    summaries: [],
    facts: [],
    directives: [],
    participants: {},
    persona: null,
    resetPoint: null,
    messagesSinceSummary: 0,
    messagesSinceFacts: 0,
    messagesSinceTopic: 0,
  };
}

function conversationRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    topic: r.topic || "",
    summaries: parseJson(r.summaries, [], `conversation ${r.id}.summaries`),
    facts: parseJson(r.facts, [], `conversation ${r.id}.facts`),
    directives: parseJson(r.directives, [], `conversation ${r.id}.directives`),
    participants: parseJson(r.participants, {}, `conversation ${r.id}.participants`),
    persona: r.persona ? parseJson(r.persona, null, `conversation ${r.id}.persona`) : null,
    resetPoint: r.reset_point,
    messagesSinceSummary: r.messages_since_summary,
    messagesSinceFacts: r.messages_since_facts,
    messagesSinceTopic: r.messages_since_topic,
  };
}

const CONVERSATION_COLUMNS = {
  name: v => v,
  topic: v => v ?? "",
  summaries: v => JSON.stringify(v ?? []),
  facts: v => JSON.stringify(v ?? []),
  directives: v => JSON.stringify(v ?? []),
  participants: v => JSON.stringify(v ?? {}),
  persona: v => (v ? JSON.stringify(v) : null),
  resetPoint: v => v ?? null,
  messagesSinceSummary: v => v ?? 0,
  messagesSinceFacts: v => v ?? 0,
  messagesSinceTopic: v => v ?? 0,
};

const COLUMN_NAMES = {
  name: "name",
  topic: "topic",
  summaries: "summaries",
  facts: "facts",
  directives: "directives",
  participants: "participants",
  persona: "persona",
  resetPoint: "reset_point",
  messagesSinceSummary: "messages_since_summary",
  messagesSinceFacts: "messages_since_facts",
  messagesSinceTopic: "messages_since_topic",
};

function getConversation(conversationId, name = null) {
  const db = openDb();
  const existing = db.prepare("SELECT * FROM conversations WHERE id=?").get(conversationId);
  if (existing) return conversationRow(existing);

  const now = Date.now();
  db.prepare(`
    INSERT OR IGNORE INTO conversations (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
  `).run(conversationId, name, now, now);
  logger.debug(`[Memory] Created conversation context ${conversationId}`);
  return defaultConversation(conversationId, name);
}

async function updateConversation(conversationId, updates) {
  return withLock(`conversation:${conversationId}`, () => {
    const db = openDb();
    getConversation(conversationId);
    const sets = [];
    const params = [];
    for (const [key, value] of Object.entries(updates)) {
      const column = COLUMN_NAMES[key];
      if (!column) continue;
      sets.push(`${column} = ?`);
      params.push(CONVERSATION_COLUMNS[key](value));
    }
    if (sets.length === 0) return getConversation(conversationId);
    sets.push("updated_at = ?");
    params.push(Date.now(), conversationId);
    db.prepare(`UPDATE conversations SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return getConversation(conversationId);
  });
}

function deleteConversation(conversationId) {
  return openDb().prepare("DELETE FROM conversations WHERE id=?").run(conversationId).changes > 0;
}

function defaultUser(userId) {
  return {
    userId,
    summaries: [],
    facts: [],
    messageCount: 0,
    messagesSinceSummary: 0,
    messagesSinceFacts: 0,
    incognito: false,
    incognitoConversations: [],
  };
}

function userRow(r) {
  if (!r) return null;
  return {
    userId: r.user_id,
    summaries: parseJson(r.summaries, [], `user ${r.user_id}.summaries`),
    // A user store only ever holds facts ABOUT its owner, so a legacy fact
    // missing subjectUserId is attributed to the owner on read. This keeps
    // (key, subjectUserId) dedup working against newly-stamped facts.
    facts: parseJson(r.facts, [], `user ${r.user_id}.facts`)
      .map(f => (f && !f.subjectUserId ? { ...f, subjectUserId: r.user_id } : f)),
    messageCount: r.message_count,
    messagesSinceSummary: r.messages_since_summary,
    messagesSinceFacts: r.messages_since_facts,
    incognito: !!r.incognito,
    incognitoConversations: parseJson(r.incognito_conversations, [], `user ${r.user_id}.incognito`),
  };
}

const USER_COLUMNS = {
  summaries: ["summaries", v => JSON.stringify(v ?? [])],
  facts: ["facts", v => JSON.stringify(v ?? [])],
  messageCount: ["message_count", v => v ?? 0],
  messagesSinceSummary: ["messages_since_summary", v => v ?? 0],
  messagesSinceFacts: ["messages_since_facts", v => v ?? 0],
  incognito: ["incognito", v => (v ? 1 : 0)],
  incognitoConversations: ["incognito_conversations", v => JSON.stringify(v ?? [])],
};

function getUser(userId) {
  const db = openDb();
  const existing = db.prepare("SELECT * FROM user_memory WHERE user_id=?").get(userId);
  if (existing) return userRow(existing);
  const now = Date.now();
  db.prepare("INSERT OR IGNORE INTO user_memory (user_id, created_at, updated_at) VALUES (?, ?, ?)")
    .run(userId, now, now);
  return defaultUser(userId);
}

// Incognito is enforced at the write boundary, not by every caller. A user who
// opted out has nothing recorded about them regardless of which code path fired
// — except the incognito flags themselves, which must remain settable.
async function updateUser(userId, updates) {
  return withLock(`user:${userId}`, () => {
    const db = openDb();
    const current = getUser(userId);
    const onlyFlags = Object.keys(updates).every(
      k => k === "incognito" || k === "incognitoConversations",
    );
    if (current.incognito && !onlyFlags) {
      logger.debug(`[Memory] User ${userId} is incognito; skipping memory write.`);
      return current;
    }

    const sets = [];
    const params = [];
    for (const [key, value] of Object.entries(updates)) {
      const spec = USER_COLUMNS[key];
      if (!spec) continue;
      sets.push(`${spec[0]} = ?`);
      params.push(spec[1](value));
    }
    if (sets.length === 0) return current;
    sets.push("updated_at = ?");
    params.push(Date.now(), userId);
    db.prepare(`UPDATE user_memory SET ${sets.join(", ")} WHERE user_id = ?`).run(...params);
    return getUser(userId);
  });
}

// True when this user's activity must not be recorded, either globally or in
// this specific conversation.
function isIncognito(userId, conversationId = null) {
  const data = getUser(userId);
  if (data.incognito) return true;
  return conversationId ? data.incognitoConversations.includes(conversationId) : false;
}

function close() {
  if (_db) {
    try { _db.close(); } catch (err) { logger.debug(`[Memory] close: ${err.message}`); }
    _db = null;
  }
}

module.exports = {
  getConversation, updateConversation, deleteConversation,
  getUser, updateUser, isIncognito, close,
};
