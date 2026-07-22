// Durable job queue backed by SQLite. Everything the engine wants to do
// *after* replying — embedding backfill, archive compaction, reminders, retried
// LLM calls — enqueues here so a turn never blocks on background work.
//
// Durability is the point: an in-memory queue loses everything on restart, and
// "embed these 40 chunks" is exactly the kind of work that must survive one.
//
// Single-process assumptions: the startup reaper rescues jobs stranded in
// 'running' by a crash. Running two workers against one database would need a
// lease column instead.

const config = require("../../config.js");
const logger = require("../util/logger");
const { withLock } = require("../util/lock");
const { openDatabase } = require("../util/db");

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS jobs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    kind         TEXT NOT NULL,
    payload      TEXT NOT NULL,
    run_at       INTEGER NOT NULL,
    priority     INTEGER NOT NULL DEFAULT 0,
    status       TEXT NOT NULL DEFAULT 'pending',
    attempts     INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    last_error   TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(status, run_at, priority DESC);
`;

let _db = null;
let _ticking = false;
let _timer = null;
const _handlers = new Map();

function openDb() {
  if (!_db) _db = openDatabase(config.JOB_DB_PATH, SCHEMA, "Jobs");
  return _db;
}

function enqueue({ kind, payload = {}, run_at = Date.now(), priority = 0, max_attempts = 3 } = {}) {
  if (!kind || typeof kind !== "string") throw new Error("Job kind is required.");
  const now = Date.now();
  const info = openDb().prepare(`
    INSERT INTO jobs (kind, payload, run_at, priority, status, attempts, max_attempts, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)
  `).run(kind, JSON.stringify(payload), run_at, priority, max_attempts, now, now);
  return info.lastInsertRowid;
}

function register(kind, handler) {
  if (typeof handler !== "function") throw new Error(`Job handler for "${kind}" must be a function.`);
  _handlers.set(kind, handler);
}

function stats() {
  const rows = openDb().prepare("SELECT status, COUNT(*) AS c FROM jobs GROUP BY status").all();
  const out = { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
  for (const r of rows) out[r.status] = r.c;
  return out;
}

// A job left in 'running' means the process died mid-execution. Requeue rather
// than leaving it stranded forever.
function reapStaleRunning() {
  const info = openDb().prepare("UPDATE jobs SET status='pending', updated_at=? WHERE status='running'").run(Date.now());
  if (info.changes > 0) logger.warn(`[Jobs] Startup reaper requeued ${info.changes} job(s) stuck in 'running'.`);
}

async function runJob(row) {
  const db = openDb();
  const handler = _handlers.get(row.kind);
  if (!handler) {
    logger.warn(`[Jobs] No handler registered for kind="${row.kind}" (id=${row.id}). Marking failed.`);
    db.prepare("UPDATE jobs SET status='failed', last_error=?, updated_at=? WHERE id=?")
      .run(`No handler for kind=${row.kind}`, Date.now(), row.id);
    return;
  }
  const payload = JSON.parse(row.payload || "{}");
  try {
    await withLock(`job:${row.id}`, () => handler(payload, { jobId: row.id, attempts: row.attempts }));
    db.prepare("UPDATE jobs SET status='done', updated_at=?, last_error=NULL WHERE id=?").run(Date.now(), row.id);
  } catch (err) {
    const msg = (err?.message || String(err)).slice(0, 1000);
    if (row.attempts >= row.max_attempts) {
      db.prepare("UPDATE jobs SET status='failed', last_error=?, updated_at=? WHERE id=?").run(msg, Date.now(), row.id);
      logger.error(`[Jobs] Job ${row.id} (${row.kind}) permanently failed after ${row.attempts} attempts: ${msg}`);
    } else {
      const backoffMs = Math.pow(2, row.attempts) * 1000;
      db.prepare("UPDATE jobs SET status='pending', run_at=?, last_error=?, updated_at=? WHERE id=?")
        .run(Date.now() + backoffMs, msg, Date.now(), row.id);
      logger.warn(`[Jobs] Job ${row.id} (${row.kind}) failed (attempt ${row.attempts}/${row.max_attempts}); retrying in ${backoffMs}ms: ${msg}`);
    }
  }
}

async function tickOnce() {
  if (_ticking) return;
  _ticking = true;
  try {
    const db = openDb();
    const due = db.prepare(`
      SELECT id FROM jobs
      WHERE status='pending' AND run_at <= ?
      ORDER BY priority DESC, run_at ASC
      LIMIT ?
    `).all(Date.now(), config.JOB_BATCH_SIZE || 5);

    for (const { id } of due) {
      // Conditional UPDATE is the claim: if another tick already took this row
      // the change count is zero and we skip it.
      const claim = db.prepare(
        "UPDATE jobs SET status='running', attempts=attempts+1, updated_at=? WHERE id=? AND status='pending'",
      ).run(Date.now(), id);
      if (claim.changes === 0) continue;
      await runJob(db.prepare("SELECT * FROM jobs WHERE id=?").get(id));
    }
  } catch (err) {
    logger.error(`[Jobs] Tick loop error: ${err.message}`);
  } finally {
    _ticking = false;
  }
}

function start({ tickIntervalMs } = {}) {
  const interval = tickIntervalMs || config.JOB_TICK_MS || 2000;
  openDb();
  reapStaleRunning();
  if (_timer) return;
  _timer = setInterval(() => { tickOnce(); }, interval);
  // unref so a queue with nothing to do never keeps the process alive.
  if (_timer.unref) _timer.unref();
  logger.info(`[Jobs] Tick loop started (every ${interval}ms, batch=${config.JOB_BATCH_SIZE || 5})`);
}

function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  if (_db) {
    try { _db.close(); } catch (_) {}
    _db = null;
  }
  logger.info("[Jobs] Tick loop stopped");
}

function list(kind, filterFn = null) {
  const rows = openDb().prepare(
    "SELECT id, payload, run_at, priority, status, created_at FROM jobs WHERE kind = ? AND status IN ('pending','running') ORDER BY run_at ASC",
  ).all(kind);
  return filterFn ? rows.filter(filterFn) : rows;
}

// Callers that accept a user-supplied job id MUST pass `ownerPredicate`, or a
// user can cancel someone else's job by guessing ids. The predicate runs
// against the parsed payload; returning false leaves the row untouched. Omit it
// only when the id came from internal code, never from model or user input.
function cancel(id, ownerPredicate = null) {
  const db = openDb();
  if (ownerPredicate) {
    const row = db.prepare("SELECT id, kind, payload, status FROM jobs WHERE id = ?").get(id);
    if (!row || (row.status !== "pending" && row.status !== "running")) return false;
    let payload;
    try { payload = JSON.parse(row.payload); }
    catch (_) { return false; }
    if (!ownerPredicate(payload, row)) return false;
  }
  return db.prepare(
    "UPDATE jobs SET status='cancelled', updated_at=? WHERE id=? AND status IN ('pending','running')",
  ).run(Date.now(), id).changes > 0;
}

module.exports = { enqueue, register, start, stop, stats, tickOnce, list, cancel };
