// Deterministic knowledge-base pre-flight.
//
// lookup_kb is a tool the model has to choose to call, which it rarely does on
// an ambient conversational turn — so curated entries only ever surfaced when
// someone asked outright. This scores each inbound turn against the KB locally
// and injects the best matches into the prompt before the first model call.
//
// Lexical only: an embedding call per inbound message would add a network
// round-trip to every single turn, which is the cost this exists to avoid.
// Title and tag hits are weighted above body hits, and tokens that appear in
// most entries are discounted so generic words don't match everything.

const store = require("./store");
const logger = require("../util/logger");
const { tokenize: sharedTokenize, RETRIEVAL_STOPWORDS } = require("../util/text");
const {
  KB_PREFLIGHT_MIN_SCORE,
  KB_PREFLIGHT_MAX_ENTRIES,
  KB_PREFLIGHT_CONTENT_CHARS,
  KB_PREFLIGHT_INDEX_TTL_MS,
} = require("../../config.js");

// Two-character tokens match far too many entries to be useful signal here,
// so KB matching is stricter than fact/directive matching.
const MIN_TOKEN_LENGTH = 3;

const _index = new Map();

function tokenize(text) {
  return sharedTokenize(text, MIN_TOKEN_LENGTH, RETRIEVAL_STOPWORDS);
}

function buildIndex(scopeId) {
  const entries = store.listForScope(scopeId) || [];
  const docs = entries.map(e => ({
    slug: e.slug,
    title: e.title,
    content: e.content,
    titleTokens: new Set(tokenize(e.title).concat(tokenize(e.slug))),
    tagTokens: new Set(tokenize(e.tags)),
    contentTokens: new Set(tokenize(e.content)),
  }));

  const docFreq = new Map();
  for (const doc of docs) {
    const all = new Set([...doc.titleTokens, ...doc.tagTokens, ...doc.contentTokens]);
    for (const t of all) docFreq.set(t, (docFreq.get(t) || 0) + 1);
  }

  const index = { docs, docFreq, builtAt: Date.now() };
  _index.set(scopeId, index);
  logger.debug(`[KBPreflight] Built index for scope ${scopeId}: ${docs.length} entries, ${docFreq.size} terms`);
  return index;
}

function getIndex(scopeId) {
  const cached = _index.get(scopeId);
  if (cached && Date.now() - cached.builtAt < (KB_PREFLIGHT_INDEX_TTL_MS || 600000)) return cached;
  return buildIndex(scopeId);
}

// Called by every KB write path. The TTL alone would leave an approved entry
// invisible for minutes, which reads as the approval not having worked.
function invalidate(scopeId) {
  if (scopeId) _index.delete(scopeId);
  else _index.clear();
}

// Rare terms carry the match. Without this a query mentioning a term common to
// the whole knowledge base would tie against every entry at once.
function idf(docFreq, totalDocs, token) {
  const df = docFreq.get(token) || 0;
  if (df === 0) return 0;
  return Math.log((totalDocs + 1) / (df + 0.5));
}

// How many query terms a document is scored against. Normalizing over EVERY
// term would let unrelated words dilute the score, so a topic mentioned inside
// a long message would silently stop matching — the denominator has to depend
// on how strong the match is, not on how much the user typed.
const SCORED_TERMS = 4;

function scoreDocs(index, queryTokens) {
  const total = index.docs.length;
  if (total === 0 || queryTokens.length === 0) return [];

  const unique = [...new Set(queryTokens)];
  const weights = new Map();
  for (const t of unique) {
    const w = idf(index.docFreq, total, t);
    if (w > 0) weights.set(t, w);
  }
  if (weights.size === 0) return [];

  // Ceiling: the best a document could do is a title hit on the k rarest terms.
  const bestTerms = [...weights.values()].sort((a, b) => b - a).slice(0, SCORED_TERMS);
  const maxPossible = bestTerms.reduce((sum, w) => sum + w * 3, 0);
  if (maxPossible <= 0) return [];

  return index.docs.map(doc => {
    const hits = [];
    for (const [t, weight] of weights) {
      if (doc.titleTokens.has(t)) hits.push(weight * 3);
      else if (doc.tagTokens.has(t)) hits.push(weight * 2);
      else if (doc.contentTokens.has(t)) hits.push(weight);
    }
    hits.sort((a, b) => b - a);
    const raw = hits.slice(0, SCORED_TERMS).reduce((sum, w) => sum + w, 0);
    return { doc, score: Math.min(1, raw / maxPossible) };
  }).sort((a, b) => b.score - a.score);
}

// Returns [{ slug, title, content, score }] above the configured threshold.
// Fails open: a broken index degrades to "no pre-flight hits", never a thrown
// turn — lookup_kb is still there as the fallback path.
function findRelevant(scopeId, text, limit = KB_PREFLIGHT_MAX_ENTRIES) {
  if (!scopeId || !text) return [];
  try {
    const index = getIndex(scopeId);
    const scored = scoreDocs(index, tokenize(text));
    const chars = KB_PREFLIGHT_CONTENT_CHARS || 400;
    return scored
      .filter(s => s.score >= (KB_PREFLIGHT_MIN_SCORE ?? 0.25))
      .slice(0, limit)
      .map(s => ({
        slug: s.doc.slug,
        title: s.doc.title,
        content: s.doc.content.length > chars ? `${s.doc.content.slice(0, chars)}...` : s.doc.content,
        score: s.score,
      }));
  } catch (err) {
    logger.warn(`[KBPreflight] Lookup failed for scope ${scopeId}: ${err.message}`);
    return [];
  }
}

function buildKbContextBlock(matches) {
  if (!Array.isArray(matches) || matches.length === 0) return "";
  const body = matches
    .map(m => `[[kb:${m.slug}]] ${m.title}\n${m.content}`)
    .join("\n\n");
  return [
    "[KnowledgeBase]",
    "Curated knowledge that matches what is being discussed right now. Treat it as already retrieved — use it directly instead of calling lookup_kb, and cite it with [[cite:kb:slug]] when you rely on it.",
    body,
  ].join("\n");
}

module.exports = { findRelevant, buildKbContextBlock, invalidate, tokenize, scoreDocs, buildIndex };
