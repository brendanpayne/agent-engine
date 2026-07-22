// Searchable message archive — the retrieval tier of the memory system.
//
// Hybrid search by design: FTS5 handles keyword recall cheaply on every query,
// and embeddings re-rank only the candidates FTS already found. A full semantic
// scan runs solely when FTS returns nothing. That keeps the common path free of
// embedding calls while still catching paraphrased queries keyword search misses.
//
// Ingestion writes on every message (a cheap INSERT OR IGNORE); embedding jobs
// are enqueued in batches at summary boundaries, so API cost and disk writes
// scale with conversation milestones rather than message volume.

const config = require("../../config.js");
const logger = require("../util/logger");
const { openDatabase, cosineSimilarity, bufferToFloatArray, embeddingToBuffer, toFloat32 } = require("../util/db");

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS message_chunks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    message_id      TEXT NOT NULL,
    author_id       TEXT NOT NULL,
    content         TEXT NOT NULL,
    chunk_index     INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    embedding       BLOB
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_id ON message_chunks(message_id, chunk_index);
  CREATE INDEX IF NOT EXISTS idx_msg_conversation ON message_chunks(conversation_id);
`;

let _db = null;
function openDb() {
  if (_db) return _db;
  _db = openDatabase(process.env.ARCHIVE_TEST_DB || config.ARCHIVE_DB_PATH, SCHEMA, "Archive");
  // FTS5 is a compile-time option. Degrade to semantic-only search rather than
  // failing to open the store on a build without it.
  try {
    _db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS message_chunks_fts USING fts5(
        content,
        conversation_id UNINDEXED,
        content_rowid=id
      );
    `);
  } catch (err) {
    logger.warn(`[Archive] FTS5 unavailable, semantic search only: ${err.message}`);
  }
  return _db;
}

function insertChunk({ conversationId, messageId, authorId, content, chunkIndex = 0, createdAt = Date.now() }) {
  const db = openDb();
  const info = db.prepare(`
    INSERT OR IGNORE INTO message_chunks (conversation_id, message_id, author_id, content, chunk_index, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(conversationId, messageId, authorId, content, chunkIndex, createdAt);
  if (info.changes > 0) {
    try {
      db.prepare("INSERT INTO message_chunks_fts (rowid, content, conversation_id) VALUES (?, ?, ?)")
        .run(info.lastInsertRowid, content, conversationId);
    } catch (err) {
      logger.warn(`[Archive] FTS5 insert failed: ${err.message}`);
    }
  }
  return info.changes > 0 ? info.lastInsertRowid : null;
}

function searchFTS(conversationId, query, limit = 30) {
  try {
    return openDb().prepare(`
      SELECT mc.id, mc.conversation_id, mc.message_id, mc.author_id, mc.content, mc.created_at, rank
      FROM message_chunks_fts
      JOIN message_chunks mc ON mc.id = message_chunks_fts.rowid
      WHERE message_chunks_fts MATCH ? AND mc.conversation_id = ?
      ORDER BY rank
      LIMIT ?
    `).all(query, conversationId, limit);
  } catch (err) {
    logger.warn(`[Archive] FTS5 search failed: ${err.message}`);
    return [];
  }
}

function scoreRows(rows, queryVec, limit) {
  const scored = rows.map(r => {
    const vec = bufferToFloatArray(r.embedding);
    if (!vec || vec.length !== queryVec.length) return null;
    const score = cosineSimilarity(queryVec, vec);
    // A zero/degenerate embedding yields NaN, which would survive a sort
    // comparison and corrupt the ordering. Drop non-finite scores.
    return Number.isFinite(score) ? { ...r, score } : null;
  }).filter(Boolean);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// Re-rank a candidate set that FTS already narrowed.
function searchSemantic(conversationId, queryEmbedding, candidateIds, limit = 5) {
  if (!candidateIds || candidateIds.length === 0) return [];
  const placeholders = candidateIds.map(() => "?").join(",");
  const rows = openDb().prepare(`
    SELECT * FROM message_chunks
    WHERE conversation_id = ? AND id IN (${placeholders}) AND embedding IS NOT NULL
  `).all(conversationId, ...candidateIds);
  return scoreRows(rows, toFloat32(queryEmbedding), limit);
}

// Fallback for when FTS found nothing. Bounded to the most recent 500 rows so
// the brute-force scan stays predictable on a long-lived conversation.
function searchSemanticFull(conversationId, queryEmbedding, limit = 5) {
  const rows = openDb().prepare(
    "SELECT * FROM message_chunks WHERE conversation_id = ? AND embedding IS NOT NULL ORDER BY created_at DESC LIMIT 500",
  ).all(conversationId);
  return scoreRows(rows, toFloat32(queryEmbedding), limit);
}

function getUnembeddedForConversation(conversationId, limit = 100) {
  return openDb().prepare(`
    SELECT id, content FROM message_chunks
    WHERE conversation_id = ? AND embedding IS NULL
    ORDER BY created_at ASC LIMIT ?
  `).all(conversationId, limit);
}

// Fetch specific rows still needing an embedding, by id. The embedding job uses
// this rather than an oldest-N window, which would silently skip a freshly
// inserted chunk once the backlog grew past that window.
function getByIds(ids) {
  if (!ids || ids.length === 0) return [];
  const ph = ids.map(() => "?").join(",");
  return openDb().prepare(
    `SELECT id, content FROM message_chunks WHERE id IN (${ph}) AND embedding IS NULL`,
  ).all(...ids);
}

function setEmbedding(id, embedding) {
  return openDb().prepare("UPDATE message_chunks SET embedding = ? WHERE id = ?")
    .run(embeddingToBuffer(embedding), id).changes > 0;
}

function countForConversation(conversationId) {
  return openDb().prepare("SELECT COUNT(*) AS c FROM message_chunks WHERE conversation_id = ?")
    .get(conversationId)?.c || 0;
}

function getOldestChunks(conversationId, limit) {
  return openDb().prepare(
    "SELECT id, message_id, author_id, content, created_at FROM message_chunks WHERE conversation_id=? ORDER BY created_at ASC LIMIT ?",
  ).all(conversationId, limit);
}

// The FTS index is content_rowid-linked, not a true external-content table, so
// deleting from the base table does NOT cascade. Both must be deleted together
// or the index accumulates orphaned rows that surface as phantom search hits.
function deleteChunks(ids) {
  if (!ids || ids.length === 0) return 0;
  const db = openDb();
  const ph = ids.map(() => "?").join(",");
  try { db.prepare(`DELETE FROM message_chunks_fts WHERE rowid IN (${ph})`).run(...ids); }
  catch (err) { logger.warn(`[Archive] FTS delete failed: ${err.message}`); }
  return db.prepare(`DELETE FROM message_chunks WHERE id IN (${ph})`).run(...ids).changes;
}

// Retention: drop rows older than `retentionDays`, then trim each conversation
// to at most `maxRowsPerConversation`. Either can be zero to skip that stage.
//
// Both axes are needed. A TTL alone lets a single busy conversation dominate
// the database; a per-conversation cap alone lets thousands of dormant
// conversations accumulate forever.
function prune({ retentionDays = 0, maxRowsPerConversation = 0 } = {}) {
  const db = openDb();
  let deletedByAge = 0;
  let deletedByCap = 0;

  if (retentionDays > 0) {
    const cutoff = Date.now() - retentionDays * 86400000;
    const oldIds = db.prepare("SELECT id FROM message_chunks WHERE created_at < ?").all(cutoff).map(r => r.id);
    deletedByAge = deleteChunks(oldIds);
  }

  if (maxRowsPerConversation > 0) {
    const conversations = db.prepare("SELECT DISTINCT conversation_id FROM message_chunks").all();
    for (const { conversation_id } of conversations) {
      const count = countForConversation(conversation_id);
      if (count <= maxRowsPerConversation) continue;
      const ids = db.prepare(
        "SELECT id FROM message_chunks WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?",
      ).all(conversation_id, count - maxRowsPerConversation).map(r => r.id);
      deletedByCap += deleteChunks(ids);
    }
  }

  // Reclaim space when a big prune lands. Cheap when nothing changed.
  if (deletedByAge + deletedByCap > 0) {
    try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); }
    catch (err) { logger.warn(`[Archive] wal_checkpoint failed: ${err.message}`); }
  }

  return { deletedByAge, deletedByCap };
}

function close() {
  if (_db) {
    try { _db.close(); } catch (err) { logger.debug(`[Archive] close: ${err.message}`); }
    _db = null;
  }
}

module.exports = {
  insertChunk, searchFTS, searchSemantic, searchSemanticFull,
  getUnembeddedForConversation, getByIds, getOldestChunks, deleteChunks,
  setEmbedding, countForConversation, prune, close,
};
