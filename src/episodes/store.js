// Episodic memory. An episode records a specific event that occurred ("on
// 2026-05-04 the team shipped the migration") as opposed to a stable semantic
// fact ("the team uses Postgres").
//
// The distinction matters for the token budget: facts are cheap and always in
// the prompt, episodes are numerous and retrieved on demand via the
// recall_episode tool. That keeps per-turn prompt size flat as history grows.
//
// Capped at MAX_EPISODES_PER_SCOPE per (scope_type, scope_id); the oldest are
// pruned inside the same transaction as the insert, so the cap always holds.

const config = require("../../config.js");
const logger = require("../util/logger");
const { openDatabase, cosineSimilarity, bufferToFloatArray, embeddingToBuffer, toFloat32 } = require("../util/db");

const MAX_EPISODES_PER_SCOPE = 100;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS episodes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_type TEXT    NOT NULL,
    scope_id   TEXT    NOT NULL,
    summary    TEXT    NOT NULL,
    embedding  BLOB,
    tags       TEXT,
    source     TEXT    NOT NULL DEFAULT 'manual',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ep_scope ON episodes(scope_type, scope_id);
  CREATE INDEX IF NOT EXISTS idx_ep_created ON episodes(scope_type, scope_id, created_at);
`;

let _db = null;
function openDb() {
  if (_db) return _db;
  _db = openDatabase(process.env.EPISODES_TEST_DB || config.EPISODES_DB_PATH, SCHEMA, "Episodes");
  try {
    _db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
        summary,
        scope_type UNINDEXED,
        scope_id   UNINDEXED,
        content_rowid=id
      );
    `);
  } catch (err) {
    logger.warn(`[Episodes] FTS5 unavailable, semantic search only: ${err.message}`);
  }
  return _db;
}

function _pruneScope(db, scopeType, scopeId) {
  const count = db.prepare(
    "SELECT COUNT(*) AS c FROM episodes WHERE scope_type=? AND scope_id=?",
  ).get(scopeType, scopeId).c;
  if (count <= MAX_EPISODES_PER_SCOPE) return;
  const ids = db.prepare(
    "SELECT id FROM episodes WHERE scope_type=? AND scope_id=? ORDER BY created_at ASC LIMIT ?",
  ).all(scopeType, scopeId, count - MAX_EPISODES_PER_SCOPE).map(r => r.id);
  if (ids.length === 0) return;
  const ph = ids.map(() => "?").join(",");
  try { db.prepare(`DELETE FROM episodes_fts WHERE rowid IN (${ph})`).run(...ids); }
  catch (err) { logger.warn(`[Episodes] FTS prune failed: ${err.message}`); }
  db.prepare(`DELETE FROM episodes WHERE id IN (${ph})`).run(...ids);
  logger.debug(`[Episodes] Pruned ${ids.length} oldest from ${scopeType}:${scopeId}`);
}

// Returns the inserted row id. The caller should enqueue an embedding job for
// it — an episode without a vector is only reachable by keyword search.
function addEpisode({ scopeType, scopeId, summary, tags = [], source = "manual" }) {
  if (!scopeType || !scopeId || !summary) throw new Error("scopeType, scopeId, summary are required");
  const db = openDb();
  const tagsJson = Array.isArray(tags) ? JSON.stringify(tags) : (tags || "[]");
  const now = Date.now();
  const insertAndPrune = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO episodes (scope_type, scope_id, summary, tags, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(scopeType, scopeId, summary, tagsJson, source, now);
    try {
      db.prepare("INSERT INTO episodes_fts (rowid, summary, scope_type, scope_id) VALUES (?, ?, ?, ?)")
        .run(info.lastInsertRowid, summary, scopeType, scopeId);
    } catch (err) {
      logger.warn(`[Episodes] FTS5 insert failed: ${err.message}`);
    }
    _pruneScope(db, scopeType, scopeId);
    return info.lastInsertRowid;
  });
  return insertAndPrune();
}

function getUnembeddedAny(limit = 100) {
  return openDb().prepare(
    "SELECT id, summary, scope_type, scope_id FROM episodes WHERE embedding IS NULL ORDER BY created_at ASC LIMIT ?",
  ).all(limit);
}

function getByIds(ids) {
  if (!ids || ids.length === 0) return [];
  const ph = ids.map(() => "?").join(",");
  return openDb().prepare(
    `SELECT id, summary FROM episodes WHERE id IN (${ph}) AND embedding IS NULL`,
  ).all(...ids);
}

function setEmbedding(id, embedding) {
  return openDb().prepare("UPDATE episodes SET embedding=? WHERE id=?")
    .run(embeddingToBuffer(embedding), id).changes > 0;
}

function scopeClause(scopePairs, prefix = "") {
  const p = prefix ? `${prefix}.` : "";
  return {
    sql: scopePairs.map(() => `(${p}scope_type=? AND ${p}scope_id=?)`).join(" OR "),
    params: scopePairs.flatMap(s => [s.scopeType, s.scopeId]),
  };
}

// Keyword search across one or more { scopeType, scopeId } pairs.
function searchFTS(scopePairs, query, limit = 30) {
  try {
    const scope = scopeClause(scopePairs, "e");
    return openDb().prepare(`
      SELECT e.id, e.scope_type, e.scope_id, e.summary, e.tags, e.source, e.created_at, rank
      FROM episodes_fts
      JOIN episodes e ON e.id = episodes_fts.rowid
      WHERE episodes_fts MATCH ? AND (${scope.sql})
      ORDER BY rank
      LIMIT ?
    `).all(query, ...scope.params, limit);
  } catch (err) {
    logger.warn(`[Episodes] FTS search failed: ${err.message}`);
    return [];
  }
}

function scoreRows(rows, queryVec, limit) {
  const scored = rows.map(r => {
    const vec = bufferToFloatArray(r.embedding);
    if (!vec || vec.length !== queryVec.length) return null;
    const score = cosineSimilarity(queryVec, vec);
    return Number.isFinite(score) ? { ...r, score } : null;
  }).filter(Boolean);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

function searchSemantic(queryEmbedding, candidateIds, limit = 5) {
  if (!candidateIds || candidateIds.length === 0) return [];
  const ph = candidateIds.map(() => "?").join(",");
  const rows = openDb().prepare(
    `SELECT * FROM episodes WHERE id IN (${ph}) AND embedding IS NOT NULL`,
  ).all(...candidateIds);
  return scoreRows(rows, toFloat32(queryEmbedding), limit);
}

function searchSemanticFull(scopePairs, queryEmbedding, limit = 5) {
  const scope = scopeClause(scopePairs);
  const rows = openDb().prepare(
    `SELECT * FROM episodes WHERE (${scope.sql}) AND embedding IS NOT NULL ORDER BY created_at DESC LIMIT 500`,
  ).all(...scope.params);
  return scoreRows(rows, toFloat32(queryEmbedding), limit);
}

function close() {
  if (_db) {
    try { _db.close(); } catch (err) { logger.debug(`[Episodes] close: ${err.message}`); }
    _db = null;
  }
}

module.exports = {
  addEpisode, getUnembeddedAny, getByIds, setEmbedding,
  searchFTS, searchSemantic, searchSemanticFull, close,
  MAX_EPISODES_PER_SCOPE,
};
