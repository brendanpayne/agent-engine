// Shared better-sqlite3 opener. Every store in the engine uses the same
// pragmas: WAL for concurrent reads during writes, synchronous=NORMAL to avoid
// an fsync per transaction (durable enough for derived/reconstructable data,
// and much kinder to flash storage), and a busy timeout so a concurrent writer
// blocks briefly instead of throwing SQLITE_BUSY.

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

function openDatabase(relativePath, schemaSql, label) {
  const dbPath = path.resolve(process.cwd(), relativePath);
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  if (schemaSql) db.exec(schemaSql);
  if (label) require("./logger").debug(`[${label}] Opened ${dbPath} (WAL)`);
  return db;
}

// Cosine similarity over two equal-length vectors. Shared by every semantic
// search path (knowledge base, archive, episodes).
function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function bufferToFloatArray(buf) {
  if (!buf) return null;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function embeddingToBuffer(embedding) {
  if (!embedding) return null;
  if (Buffer.isBuffer(embedding)) return embedding;
  if (embedding instanceof Float32Array) return Buffer.from(embedding.buffer);
  if (Array.isArray(embedding)) return Buffer.from(new Float32Array(embedding).buffer);
  throw new Error("embedding must be Float32Array, Array, or Buffer");
}

function toFloat32(vec) {
  return vec instanceof Float32Array ? vec : new Float32Array(vec);
}

module.exports = {
  openDatabase,
  cosineSimilarity,
  bufferToFloatArray,
  embeddingToBuffer,
  toFloat32,
};
