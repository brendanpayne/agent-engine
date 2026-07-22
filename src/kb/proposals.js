// Human-in-the-loop gate for agent-authored knowledge.
//
// The agent can propose a knowledge-base entry but never writes one directly:
// a proposal sits in `pending` until a human approves it, at which point it is
// promoted into the KB proper. This is the difference between a memory system
// that compounds knowledge and one that compounds its own hallucinations.
//
// Deliberately UI-free. The host decides how a reviewer sees a pending
// proposal — a dashboard, an email, a chat message with buttons — and calls
// approve()/reject() with the outcome.

const crypto = require("crypto");
const config = require("../../config.js");
const logger = require("../util/logger");
const { withLock } = require("../util/lock");
const { openDatabase } = require("../util/db");
const kbStore = require("./store");

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS kb_proposals (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_id       TEXT NOT NULL,
    title          TEXT NOT NULL,
    content        TEXT NOT NULL,
    tags           TEXT,
    source         TEXT NOT NULL DEFAULT 'agent',
    origin_user_id TEXT,
    status         TEXT NOT NULL DEFAULT 'pending',
    dedup_hash     TEXT NOT NULL,
    reviewer_id    TEXT,
    reviewed_at    INTEGER,
    created_at     INTEGER NOT NULL,
    UNIQUE(scope_id, dedup_hash)
  );
  CREATE INDEX IF NOT EXISTS idx_prop_status ON kb_proposals(scope_id, status);
`;

let _db = null;
function openDb() {
  if (!_db) _db = openDatabase(process.env.KB_TEST_DB || config.KB_DB_PATH, SCHEMA, "KBProposals");
  return _db;
}

function slugify(title) {
  return String(title).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "entry";
}

// Hash normalized title + body so the same proposal made twice (a likely
// outcome when the agent re-reasons over the same conversation) collapses to
// one pending row instead of spamming the reviewer.
function dedupHash(title, content) {
  const norm = s => String(s).toLowerCase().replace(/\s+/g, " ").trim();
  return crypto.createHash("sha256").update(`${norm(title)}::${norm(content)}`).digest("hex");
}

function row(r) {
  if (!r) return null;
  return {
    id: r.id,
    scopeId: r.scope_id,
    title: r.title,
    content: r.content,
    tags: r.tags,
    source: r.source,
    originUserId: r.origin_user_id,
    status: r.status,
    reviewerId: r.reviewer_id,
    reviewedAt: r.reviewed_at,
    createdAt: r.created_at,
  };
}

// Returns the created proposal, or null when an identical one is already
// pending. Null is not an error — the caller tells the model the entry is
// already queued for review.
function propose({ scopeId, title, content, tags = null, source = "agent", originUserId = null }) {
  if (!scopeId || !title || !content) throw new Error("scopeId, title, content are required.");
  const db = openDb();
  const hash = dedupHash(title, content);
  const existing = db.prepare(
    "SELECT * FROM kb_proposals WHERE scope_id=? AND dedup_hash=? AND status='pending'",
  ).get(scopeId, hash);
  if (existing) return null;

  // A previously rejected proposal can be re-proposed: the upsert flips it back
  // to pending rather than tripping the unique constraint.
  db.prepare(`
    INSERT INTO kb_proposals (scope_id, title, content, tags, source, origin_user_id, status, dedup_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    ON CONFLICT(scope_id, dedup_hash) DO UPDATE SET
      status='pending', title=excluded.title, content=excluded.content, created_at=excluded.created_at
  `).run(scopeId, title, content, tags, source, originUserId, hash, Date.now());
  return row(db.prepare("SELECT * FROM kb_proposals WHERE scope_id=? AND dedup_hash=?").get(scopeId, hash));
}

function getById(id) {
  return row(openDb().prepare("SELECT * FROM kb_proposals WHERE id=?").get(id));
}

function listPending(scopeId) {
  return openDb().prepare(
    "SELECT * FROM kb_proposals WHERE scope_id=? AND status='pending' ORDER BY created_at ASC",
  ).all(scopeId).map(row);
}

// Promote a pending proposal into the knowledge base. The KB write and the
// status flip happen under the same lock so a double-approval cannot create
// two entries. Slug collisions get a numeric suffix rather than failing.
async function approve(id, reviewerId) {
  const proposal = getById(id);
  if (!proposal) return { ok: false, reason: "Proposal not found." };
  if (proposal.status !== "pending") return { ok: false, reason: `Proposal is already ${proposal.status}.` };

  return withLock(`kb-proposal:${id}`, async () => {
    const current = getById(id);
    if (current.status !== "pending") return { ok: false, reason: `Proposal is already ${current.status}.` };

    let slug = slugify(current.title);
    let suffix = 1;
    while (kbStore.getBySlug(current.scopeId, slug)) {
      slug = `${slugify(current.title)}-${++suffix}`;
    }

    const entry = await kbStore.create({
      scopeId: current.scopeId,
      slug,
      title: current.title,
      content: current.content,
      tags: current.tags,
      creatorId: reviewerId || "system",
    });

    openDb().prepare("UPDATE kb_proposals SET status='approved', reviewer_id=?, reviewed_at=? WHERE id=?")
      .run(reviewerId || null, Date.now(), id);
    logger.info(`[KBProposals] Approved proposal ${id} -> kb entry "${slug}"`);
    return { ok: true, entry };
  });
}

function reject(id, reviewerId) {
  const info = openDb().prepare(
    "UPDATE kb_proposals SET status='rejected', reviewer_id=?, reviewed_at=? WHERE id=? AND status='pending'",
  ).run(reviewerId || null, Date.now(), id);
  if (info.changes === 0) return { ok: false, reason: "No pending proposal with that id." };
  logger.info(`[KBProposals] Rejected proposal ${id}`);
  return { ok: true };
}

// Hard-delete. Used when delivery to a reviewer failed and the row would
// otherwise block a retry via its dedup hash.
function remove(id) {
  return openDb().prepare("DELETE FROM kb_proposals WHERE id=?").run(id).changes > 0;
}

function close() {
  if (_db) {
    try { _db.close(); } catch (err) { logger.debug(`[KBProposals] close: ${err.message}`); }
    _db = null;
  }
}

module.exports = { propose, getById, listPending, approve, reject, remove, close };
