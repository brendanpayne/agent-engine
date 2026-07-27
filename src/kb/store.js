// Curated knowledge-base store. Entries are scoped by an opaque `scopeId` —
// a workspace, tenant, team, or whatever partition the host application uses —
// with embedding-backed semantic search.
//
// Search is brute-force cosine in JS. That is the right call under roughly a
// thousand entries per scope: no index to maintain, no extension to install,
// and the vector comparison is dwarfed by the embedding round-trip anyway.

const config = require("../../config.js");
const logger = require("../util/logger");
const { withLock } = require("../util/lock");
const { openDatabase, cosineSimilarity, bufferToFloatArray, embeddingToBuffer, toFloat32 } = require("../util/db");

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS kb_entries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_id   TEXT NOT NULL,
    slug       TEXT NOT NULL,
    title      TEXT NOT NULL,
    content    TEXT NOT NULL,
    tags       TEXT,
    embedding  BLOB,
    creator_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(scope_id, slug)
  );
  CREATE INDEX IF NOT EXISTS idx_kb_scope ON kb_entries(scope_id);
  CREATE INDEX IF NOT EXISTS idx_kb_slug ON kb_entries(scope_id, slug);
`;

let _db = null;
function openDb() {
  if (!_db) _db = openDatabase(process.env.KB_TEST_DB || config.KB_DB_PATH, SCHEMA, "KB");
  return _db;
}

// Required lazily: preflight indexes this store, so a top-level require here
// would be a cycle. Every write path drops the cached lexical index for the
// scope, otherwise a newly approved entry stays invisible to pre-flight until
// the TTL lapses — which reads as the approval not having worked.
function invalidatePreflight(scopeId) {
  try {
    require("./preflight").invalidate(scopeId);
  } catch (err) {
    logger.debug(`[KB] Pre-flight invalidation skipped: ${err.message}`);
  }
}

function row(r) {
  if (!r) return null;
  return {
    id: r.id,
    scopeId: r.scope_id,
    slug: r.slug,
    title: r.title,
    content: r.content,
    tags: r.tags,
    embedding: r.embedding,
    creatorId: r.creator_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function create({ scopeId, slug, title, content, tags, creatorId }) {
  return withLock(`kb:${scopeId}`, () => {
    if (!scopeId || !slug || !title || !content || !creatorId) {
      throw new Error("scopeId, slug, title, content, creatorId are required.");
    }
    const db = openDb();
    const now = Date.now();
    const info = db.prepare(`
      INSERT INTO kb_entries (scope_id, slug, title, content, tags, creator_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(scopeId, slug, title, content, tags || null, creatorId, now, now);
    invalidatePreflight(scopeId);
    return getById(info.lastInsertRowid);
  });
}

// Editing the text invalidates the stored vector — null it out so the caller's
// re-embed job picks the row back up rather than searching against stale content.
async function update({ scopeId, slug, title, content, tags }) {
  return withLock(`kb:${scopeId}`, () => {
    const db = openDb();
    const current = db.prepare("SELECT * FROM kb_entries WHERE scope_id=? AND slug=?").get(scopeId, slug);
    if (!current) return null;
    db.prepare(`
      UPDATE kb_entries SET title=?, content=?, tags=?, updated_at=?, embedding=NULL
      WHERE scope_id=? AND slug=?
    `).run(
      title !== undefined ? title : current.title,
      content !== undefined ? content : current.content,
      tags !== undefined ? tags : current.tags,
      Date.now(), scopeId, slug,
    );
    invalidatePreflight(scopeId);
    return getBySlug(scopeId, slug);
  });
}

function getBySlug(scopeId, slug) {
  return row(openDb().prepare("SELECT * FROM kb_entries WHERE scope_id=? AND slug=?").get(scopeId, slug));
}

function getById(id) {
  return row(openDb().prepare("SELECT * FROM kb_entries WHERE id=?").get(id));
}

function listForScope(scopeId) {
  return openDb().prepare("SELECT * FROM kb_entries WHERE scope_id=? ORDER BY title ASC").all(scopeId).map(row);
}

function deleteBySlug(scopeId, slug) {
  const removed = openDb().prepare("DELETE FROM kb_entries WHERE scope_id=? AND slug=?").run(scopeId, slug).changes > 0;
  if (removed) invalidatePreflight(scopeId);
  return removed;
}

function getUnembedded(limit = 100) {
  return openDb().prepare(
    "SELECT id, scope_id, slug, title, content FROM kb_entries WHERE embedding IS NULL ORDER BY updated_at ASC LIMIT ?",
  ).all(limit);
}

function setEmbedding(scopeId, slug, embedding) {
  const buf = embeddingToBuffer(embedding);
  return openDb().prepare("UPDATE kb_entries SET embedding=? WHERE scope_id=? AND slug=?")
    .run(buf, scopeId, slug).changes > 0;
}

function search(scopeId, queryEmbedding, limit = 3) {
  const queryVec = toFloat32(queryEmbedding);
  const rows = openDb().prepare("SELECT * FROM kb_entries WHERE scope_id=? AND embedding IS NOT NULL").all(scopeId);

  const scored = rows.map(r => {
    const entryVec = bufferToFloatArray(r.embedding);
    // A dimension mismatch means the row was embedded with a different model.
    // Skip it rather than comparing incompatible vector spaces.
    if (!entryVec || entryVec.length !== queryVec.length) return null;
    const score = cosineSimilarity(queryVec, entryVec);
    return Number.isFinite(score) ? { ...row(r), score } : null;
  }).filter(Boolean);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

function close() {
  if (_db) {
    try { _db.close(); } catch (err) { logger.debug(`[KB] close: ${err.message}`); }
    _db = null;
  }
}

module.exports = {
  create, update, getBySlug, getById, listForScope,
  deleteBySlug, getUnembedded, setEmbedding, search, close,
};
