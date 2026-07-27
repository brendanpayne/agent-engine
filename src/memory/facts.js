// Fact extraction, merging, scoring, and compression.
//
// A "fact" is a key=value assertion about a subject, carrying provenance:
// when it was last seen, how many times it has been reinforced, how confident
// the extractor was, and who it is about. That metadata is what makes the store
// converge instead of drifting — repetition strengthens a fact, contradiction
// replaces it, silence lets it expire, and low-confidence extractions must
// earn their way into the prompt.
//
// Pure functions here (mergeFacts, scoreFacts, buildFactsBlock,
// valueOverlapsExisting) have no I/O and are directly unit-testable.

const {
  MAX_FACTS,
  MAX_FACTS_IN_PROMPT,
  FACT_TTL_DAYS,
  FACT_CONFIDENCE_THRESHOLD,
  LOW_BUDGET_MODE,
  CONVO_MODEL,
  IMMEDIATE_FACTS_ENABLED,
  IMMEDIATE_FACTS_MIN_LENGTH,
  IMMEDIATE_FACTS_DEBOUNCE_MS,
  FACT_RELEVANCE_WEIGHT,
} = require("../../config.js");
const logger = require("../util/logger");
const { withLock } = require("../util/lock");
const { tokenize } = require("../util/text");
const { chatWithSchema } = require("../schemas");
const store = require("./store");

// Gates for the immediate (per-message) classifier. Running an LLM call on
// every message is wasteful when most carry no durable information, so a cheap
// keyword pre-filter decides whether the classifier is worth invoking at all.
const USER_KEYWORDS = /\b(i|i'?m|my|mine|me|myself)\b|\b(like|love|hate|prefer|enjoy|work|live|study|play|watch|read|am|use|own|have|listen|speak|born|grew)\b/i;
const CONTEXT_KEYWORDS = /\b(tomorrow|tonight|today|yesterday|next\s+week|meeting|event|everyone|we\s+should|let'?s|scheduled|plan(ning)?|deadline|launch|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i;

// Debounce buckets for immediate extraction, keyed by "user:<id>" /
// "conversation:<id>". Process-local; a restart simply allows one extra call.
const _debounce = new Map();

function tokenizeValue(v) {
  return tokenize(v);
}

function normalizeFactKey(rawKey) {
  return String(rawKey || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

// Hedging and joke markers make an assertion unreliable. Marking it low
// confidence keeps it out of the prompt until repetition confirms it.
function detectConfidence(text) {
  if (!text) return "high";
  if (/\b(lol|jk|haha+|maybe|i think|sort of|kinda)\b|\/s\b/i.test(text)) return "low";
  return "high";
}

function shouldSkipImmediate(text, scope) {
  if (!text || text.length < (IMMEDIATE_FACTS_MIN_LENGTH || 0)) return true;
  if (scope === "user") return !USER_KEYWORDS.test(text);
  if (scope === "conversation") return !CONTEXT_KEYWORDS.test(text);
  return false;
}

function checkDebounce(bucketKey) {
  const now = Date.now();
  const last = _debounce.get(bucketKey) || 0;
  if (now - last < (IMMEDIATE_FACTS_DEBOUNCE_MS || 0)) return false;
  _debounce.set(bucketKey, now);
  return true;
}

// Shared entry gate for every background extractor (user facts, context facts,
// standing directives). These each ran the same keyword-gate → incognito →
// debounce sequence as separate copies, which is how a guard added to one came
// to be missing from another. One implementation means a check added here
// cannot silently apply to only some scopes.
function shouldExtract({ label, text, gate, userId, conversationId, debounceKey }) {
  if (!text || !gate(text)) {
    logger.debug(`[${label}] skipped: gate (len=${text?.length ?? 0})`);
    return false;
  }
  if (userId && store.isIncognito(userId, conversationId)) {
    logger.debug(`[${label}] skipped: speaker incognito`);
    return false;
  }
  if (!checkDebounce(debounceKey)) {
    logger.debug(`[${label}] skipped: debounce`);
    return false;
  }
  return true;
}

function cleanupExpiredFacts(facts) {
  if (!FACT_TTL_DAYS || !Array.isArray(facts)) return facts;
  const ttlMs = FACT_TTL_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();
  return facts.filter(fact => {
    if (!fact?.updatedAt) return true;   // no timestamp: keep, can't age it
    if (fact.pinned) return true;        // pinned facts never expire
    return now - fact.updatedAt < ttlMs;
  });
}

// Identity anchors (name, age, location, job, language) are what the model most
// needs to not contradict itself, so they bypass the scoring budget entirely.
function isCoreIdentityKey(key) {
  return /^(name|age|location|job|language)(_|$)/.test(key || "");
}

// Lexical overlap between the current turn's cue tokens and a fact. Without
// this, selection is purely recency+reinforcement, so a fact that answers the
// question being asked right now loses its slot to unrelated recent chatter.
// A cue hitting the fact's KEY ("cat" against pet_cat_name) is a much stronger
// signal than one hitting its value, so a single key match alone is already
// enough to pull a stale fact into the prompt.
function relevanceScore(fact, cueTokens) {
  if (!cueTokens || cueTokens.size === 0) return 0;
  const keyTokens = new Set(tokenizeValue(fact.key));
  const valueTokens = new Set(tokenizeValue(fact.value));
  let keyHits = 0;
  let valueHits = 0;
  for (const t of cueTokens) {
    if (keyTokens.has(t)) keyHits++;
    else if (valueTokens.has(t)) valueHits++;
  }
  if (keyHits === 0 && valueHits === 0) return 0;
  return Math.min(1, keyHits * 0.6 + valueHits * 0.4);
}

// Perception payloads run to thousands of characters (a fetched page body).
// Feeding all of it in would make almost every stored fact score a relevance
// hit, flattening the ranking this scoring exists to sharpen — so only the
// leading, most topical slice of a perception block is used as a cue.
const CUE_PERCEPTION_CHARS = 300;

function cueSlice(text) {
  return typeof text === "string" ? text.slice(0, CUE_PERCEPTION_CHARS) : text;
}

// Cue tokens for relevance scoring: what is actually being talked about this
// turn (the message text plus any image/link perception).
function buildCueTokens(...texts) {
  const tokens = new Set();
  for (const text of texts) {
    if (!text) continue;
    for (const t of tokenizeValue(text)) tokens.add(t);
  }
  return tokens;
}

// Recency and reinforcement, weighted 60/40, blended with relevance to the
// current turn when cue tokens are supplied. Recency dominates the base score
// because a stale fact is more likely to be wrong than an unrepeated one is to
// be unimportant.
function scoreFacts(facts, now = Date.now(), cueTokens = null) {
  const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
  const relWeight = (cueTokens && cueTokens.size > 0) ? (FACT_RELEVANCE_WEIGHT ?? 0) : 0;
  const remaining = 1 - relWeight;
  return facts.map(f => {
    const age = Math.max(0, now - (f.updatedAt || 0));
    const recencyScore = Math.max(0, 1 - age / ninetyDaysMs);
    const reinforceNorm = Math.min(1, (f.reinforcedCount || 1) / 5);
    const base = reinforceNorm * 0.4 + recencyScore * 0.6;
    return { ...f, _score: base * remaining + relevanceScore(f, cueTokens) * relWeight };
  });
}

// Renders the highest-value facts as a prompt block. `maxOverride` lets several
// blocks share one total budget (see buildMultiUserFactsBlock). `cueTokens`
// biases selection toward what this turn is actually about.
function buildFactsBlock(tag, factsArray, maxOverride = null, cueTokens = null) {
  if (!Array.isArray(factsArray) || factsArray.length === 0) return "";

  const filtered = factsArray.filter(f => {
    if (!f) return false;
    // A low-confidence fact must be reinforced before it is trusted enough to
    // influence a reply.
    if (f.confidence === "low" && (f.reinforcedCount || 1) < FACT_CONFIDENCE_THRESHOLD) return false;
    return true;
  });
  if (filtered.length === 0) return "";

  const core = filtered.filter(f => isCoreIdentityKey(f.key));
  const rest = filtered.filter(f => !isCoreIdentityKey(f.key));
  const scored = scoreFacts(rest, Date.now(), cueTokens).sort((a, b) => b._score - a._score);
  const effectiveMax = (maxOverride !== null && maxOverride !== undefined)
    ? maxOverride
    : (LOW_BUDGET_MODE
      ? Math.min(MAX_FACTS_IN_PROMPT || filtered.length, 8)
      : (MAX_FACTS_IN_PROMPT || filtered.length));
  const slots = Math.max(0, effectiveMax - core.length);
  const selected = [...core, ...scored.slice(0, slots)];
  // Alphabetical output keeps the block byte-stable across turns when the
  // contents haven't changed, which preserves the provider's prompt cache.
  selected.sort((a, b) => a.key.localeCompare(b.key));

  logger.debug(`[Facts] ${tag}: total=${factsArray.length} filtered=${filtered.length} core=${core.length} selected=${selected.length}`);
  return `[${tag} n=${selected.length}]\n${selected.map(f => `${f.key}: ${f.value}`).join("\n")}`;
}

// One block per participant who spoke recently. The current speaker gets ~60%
// of the budget and the rest is split evenly, so the model can reason about
// everyone present without conflating their identities.
function buildMultiUserFactsBlock(currentUserId, orderedIds, perUserFacts, nameOf, cueTokens = null) {
  const totalBudget = LOW_BUDGET_MODE
    ? Math.min(MAX_FACTS_IN_PROMPT || 8, 8)
    : (MAX_FACTS_IN_PROMPT || 15);
  const others = orderedIds.filter(id => id !== currentUserId);
  const speakerBudget = others.length > 0 ? Math.max(1, Math.round(totalBudget * 0.6)) : totalBudget;
  const otherBudgetEach = others.length > 0
    ? Math.max(1, Math.floor((totalBudget - speakerBudget) / others.length))
    : 0;

  const blocks = [];
  for (const uid of [currentUserId, ...others]) {
    const facts = perUserFacts[uid];
    if (!Array.isArray(facts) || facts.length === 0) continue;
    const budget = uid === currentUserId ? speakerBudget : otherBudgetEach;
    if (budget <= 0) continue;
    const block = buildFactsBlock(`UserFacts name="${nameOf(uid) || "user"}" id="${uid}"`, facts, budget, cueTokens);
    if (block) blocks.push(block);
  }
  return blocks.join("\n\n");
}

// Jaccard overlap catches restatements that use a different key — "likes_coffee"
// vs "favorite_drink=coffee" would otherwise both persist and contradict later.
function valueOverlapsExisting(newValue, existingFacts, threshold = 0.6) {
  const newTokens = new Set(tokenizeValue(newValue));
  if (newTokens.size === 0) return null;
  for (const f of existingFacts) {
    const existingTokens = new Set(tokenizeValue(f.value));
    if (existingTokens.size === 0) continue;
    let intersect = 0;
    for (const t of newTokens) if (existingTokens.has(t)) intersect++;
    const union = new Set([...newTokens, ...existingTokens]).size;
    if (union === 0) continue;
    if (intersect / union >= threshold) return f;
  }
  return null;
}

// Merge newly extracted facts into an existing set.
//
// Dedup, update, and retraction all match on (key, subjectUserId), so a fact
// about one person never overwrites the same-keyed fact about another.
// raw.subjectUserId wins; otherwise defaultSubjectId applies. Facts with no
// subject compare as null, preserving key-only behavior for shared context.
function mergeFacts(existingFacts, parsedFacts, sourceSnippet = "", defaultSubjectId = null) {
  let combined = Array.isArray(existingFacts) ? existingFacts.map(f => ({
    key: f.key,
    value: f.value,
    updatedAt: f.updatedAt ?? Date.now(),
    confidence: f.confidence || "high",
    extractedFrom: f.extractedFrom || "",
    reinforcedCount: f.reinforcedCount || 1,
    ...(f.subjectUserId ? { subjectUserId: f.subjectUserId } : {}),
    ...(f.pinned ? { pinned: true } : {}),
  })) : [];

  combined = cleanupExpiredFacts(combined);
  const snippet = (sourceSnippet || "").slice(0, 80);

  for (const raw of parsedFacts) {
    const key = normalizeFactKey(raw.key);
    const value = (raw.value ?? "").toString().trim();
    if (!key) continue;

    const sid = raw.subjectUserId || defaultSubjectId || null;
    const sameSubject = f => (f.subjectUserId || null) === sid;
    const withSubject = extra => ({ ...extra, ...(sid ? { subjectUserId: sid } : {}) });

    // Explicit retraction sentinel emitted by the classifier.
    if (value === "__deleted__") {
      const idx = combined.findIndex(f => f.key === key && sameSubject(f));
      if (idx !== -1) {
        if (combined[idx].pinned) {
          logger.debug(`[Facts] Refused to delete pinned fact: ${key}`);
        } else {
          combined.splice(idx, 1);
          logger.debug(`[Facts] Deleted: ${key}`);
        }
      }
      continue;
    }

    if (value.length < 2) continue;

    const keyIdx = combined.findIndex(f => f.key === key && sameSubject(f));
    if (keyIdx !== -1) {
      if (combined[keyIdx].value === value) {
        // Same assertion again: strengthen rather than duplicate.
        combined[keyIdx].reinforcedCount = (combined[keyIdx].reinforcedCount || 1) + 1;
        combined[keyIdx].updatedAt = Date.now();
        if (raw.confidence === "high") combined[keyIdx].confidence = "high";
      } else {
        const old = combined[keyIdx].value;
        combined[keyIdx] = withSubject({
          key, value,
          updatedAt: Date.now(),
          confidence: raw.confidence || "high",
          extractedFrom: snippet,
          reinforcedCount: 1,
        });
        logger.info(`[Facts] Updated: ${key} "${old}" -> "${value}"`);
      }
      continue;
    }

    // Only treat as a near-duplicate within the same subject — identical
    // phrasings about two different people must not merge.
    const overlap = valueOverlapsExisting(value, combined.filter(sameSubject));
    if (overlap) {
      overlap.reinforcedCount = (overlap.reinforcedCount || 1) + 1;
      overlap.updatedAt = Date.now();
      logger.debug(`[Facts] Overlap reinforcement: "${key}=${value}" -> "${overlap.key}=${overlap.value}"`);
      continue;
    }

    combined.push(withSubject({
      key, value,
      updatedAt: Date.now(),
      confidence: raw.confidence || "high",
      extractedFrom: snippet,
      reinforcedCount: 1,
    }));
    logger.debug(`[Facts] Added: ${key}=${value} (confidence=${raw.confidence || "high"}, subject=${sid || "default"})`);
  }

  return combined;
}

function sortAndPruneFacts(combined) {
  combined.sort((a, b) => {
    const aTime = a.updatedAt || 0;
    const bTime = b.updatedAt || 0;
    if (aTime !== bTime) return bTime - aTime;
    return a.key.localeCompare(b.key);
  });
  if (combined.length > MAX_FACTS) {
    // Pinned facts survive the size cap; only unpinned overflow is dropped.
    const pinned = combined.filter(f => f.pinned);
    const unpinned = combined.filter(f => !f.pinned);
    combined = [...pinned, ...unpinned.slice(0, Math.max(0, MAX_FACTS - pinned.length))];
  }
  return combined;
}

// LLM-driven compaction for when a store approaches MAX_FACTS. Groups by key
// prefix and only sends genuinely duplicated groups to the model, so a store
// with no redundancy costs nothing. Fails open: any error returns the input
// unchanged rather than risking data loss on a bad model response.
async function compressFacts(facts, scope = "conversation", subjectId = null) {
  if (!Array.isArray(facts) || facts.length === 0) return facts;
  try {
    const pinned = facts.filter(f => f.pinned);
    const unpinned = facts.filter(f => !f.pinned);
    const groups = new Map();
    for (const f of unpinned) {
      const prefix = (f.key.split("_")[0] || f.key).toLowerCase();
      if (!groups.has(prefix)) groups.set(prefix, []);
      groups.get(prefix).push(f);
    }
    const dupGroups = [...groups.entries()].filter(([, arr]) => arr.length >= 2);
    logger.debug(`[Facts] compress ${scope}: input=${facts.length} groups=${groups.size} duplicates=${dupGroups.length}`);
    if (dupGroups.length === 0) return facts;

    const grouped = dupGroups
      .map(([prefix, arr]) => `# ${prefix}\n${arr.map(f => `${f.key}=${f.value}`).join("\n")}`)
      .join("\n\n");

    const res = await chatWithSchema({
      schemaName: "compress-facts",
      model: CONVO_MODEL,
      messages: [
        { role: "system", content: "You compress and deduplicate memory facts." },
        { role: "user", content: [
          `You are merging redundant facts in a ${scope}-level memory store.`,
          "For each group below, respond with ONLY valid JSON matching the schema: {\"facts\": [{\"key\":\"...\",\"value\":\"...\"}]}.",
          "Combine semantically duplicate facts. Preserve distinct facts. Do NOT add commentary.",
          "",
          grouped,
          "",
          "[Merged Facts]",
        ].join("\n") },
      ],
      max_tokens: 512,
      temperature: 0,
      timeoutMs: 30_000,
      label: "compressFacts",
      variant: `compress_${scope}`,
    });

    const compressed = (res.validated?.facts || [])
      .map(f => ({ key: normalizeFactKey(f.key), value: f.value.trim() }))
      .filter(f => f.key && f.value.length >= 2);
    if (compressed.length === 0) return facts;

    const groupedKeys = new Set(dupGroups.flatMap(([, arr]) => arr.map(f => f.key)));
    const kept = unpinned.filter(f => !groupedKeys.has(f.key));
    const mergedIn = compressed.map(c => ({
      key: c.key,
      value: c.value,
      updatedAt: Date.now(),
      confidence: "high",
      extractedFrom: "compressed",
      reinforcedCount: 1,
      ...(subjectId ? { subjectUserId: subjectId } : {}),
    }));
    const result = [...pinned, ...kept, ...mergedIn];
    logger.info(`[Facts] compress ${scope}: ${facts.length} -> ${result.length} (pinned=${pinned.length}, ${groupedKeys.size} grouped -> ${mergedIn.length} merged)`);
    return result;
  } catch (err) {
    logger.warn(`[Facts] compressFacts failed, keeping originals: ${err.message}`);
    return facts;
  }
}

const USER_CLASSIFIER_PROMPT = [
  "Extract permanent, identity-level facts about a person from the message.",
  "Respond with ONLY valid JSON matching the schema: {\"facts\": [{\"key\":\"...\",\"value\":\"...\",\"confidence\":\"high|low\",\"subject\":\"...\"}]}.",
  "The \"subject\" field names WHO the fact is about: use \"self\" when the speaker states a fact about themselves, or the other person's name exactly as written when the fact is about someone else they mention.",
  "Empty facts array if none.",
  "DO NOT extract: temporary states (tired/hungry/bored), hypotheticals, sarcasm (lol/jk//s).",
  "Use __deleted__ as the value if the speaker negates or retracts a prior fact (set subject the same way).",
  "",
  "Examples:",
  "\"I work as a nurse in Boston\" -> job=nurse (subject=self), location=Boston (subject=self)",
  "\"I love ramen\" -> favorite_food=ramen (subject=self)",
  "\"Bob is allergic to peanuts\" -> allergy=peanuts (subject=Bob)",
  "\"I'm tired\" -> (empty)",
  "\"lol maybe I like pineapple pizza\" -> (empty)",
  "\"I don't play tennis anymore\" -> sport=__deleted__ (subject=self)",
].join("\n");

const CONTEXT_CLASSIFIER_PROMPT = [
  "Extract shared-context facts from the message: events, plans, group decisions, recurring activities.",
  "Respond with ONLY valid JSON matching the schema: {\"facts\": [{\"key\":\"...\",\"value\":\"...\",\"confidence\":\"high|low\"}]}.",
  "Empty facts array if none.",
  "DO NOT extract: personal/first-person facts, temporary states, hypotheticals, sarcasm.",
  "NEVER store individual preferences, hobbies, or identity traits as shared facts. If a message is about a personal preference, return an empty array.",
  "Use __deleted__ as the value for retractions.",
  "",
  "Examples:",
  "\"Meeting tomorrow at 5pm\" -> meeting_tomorrow=5pm",
  "\"Let's do the release review on Friday\" -> event_release_review=friday",
  "\"I feel tired\" -> (empty)",
  "\"I love Earl Grey tea\" -> (empty)",
  "\"jk about the deadline\" -> event_deadline=__deleted__",
].join("\n");

async function runImmediateClassifier(text, scope) {
  const res = await chatWithSchema({
    schemaName: "fact-extraction",
    model: CONVO_MODEL,
    messages: [
      { role: "system", content: scope === "user" ? USER_CLASSIFIER_PROMPT : CONTEXT_CLASSIFIER_PROMPT },
      { role: "user", content: text },
    ],
    max_tokens: 200,
    temperature: 0,
    timeoutMs: 20_000,
    label: `immediate-${scope}`,
    variant: `immediate_${scope}`,
  });
  if (res.validated?.facts) return res.validated.facts.filter(f => f.key);
  logger.debug(`[Facts] immediate classifier (${scope}) returned nothing usable`);
  return [];
}

// Resolve a subject name emitted by the classifier to a stable user ID.
// "self"/empty/the speaker's own name resolves to the speaker. Otherwise match
// the participant registry (current or former names). Unresolvable names fall
// back to the speaker so a fact is never attributed to the wrong person.
function resolveSubjectId(subject, authorId, authorName, participants) {
  const raw = (subject || "").trim().toLowerCase();
  if (!raw || raw === "self" || raw === "me" || raw === "i" ||
      (authorName && raw === authorName.toLowerCase())) {
    return authorId;
  }
  for (const [uid, p] of Object.entries(participants || {})) {
    const names = [p.currentName, ...(Array.isArray(p.namesSeen) ? p.namesSeen : [])];
    if (names.some(n => n && n.toLowerCase() === raw)) return uid;
  }
  return authorId;
}

// Atomically merge facts into a subject's store. Read, merge, and write happen
// inside one per-user lock: the debounce is keyed on the AUTHOR, not the
// subject, so two people talking about the same person race here.
// Returns { before, after }, or null when the subject opted out.
async function mergeUserFacts(subjectId, newFacts, sourceText) {
  return withLock(`user-facts:${subjectId}`, async () => {
    const data = store.getUser(subjectId);
    if (data.incognito) return null;
    const before = (data.facts || []).length;
    const pruned = sortAndPruneFacts(mergeFacts(data.facts || [], newFacts, sourceText, subjectId));
    await store.updateUser(subjectId, { facts: pruned });
    return { before, after: pruned.length };
  });
}

// Per-message extraction for the speaker and anyone they mention. Facts are
// routed to the store of the person they are ABOUT, so a fact about Bob lives
// in Bob's store and surfaces when Bob speaks — not the author's.
async function extractImmediateUserFacts({ text, userId, userName, conversationId, participants }) {
  if (!IMMEDIATE_FACTS_ENABLED) return;
  if (!shouldExtract({
    label: `Facts user [${userId}]`,
    text,
    gate: t => !shouldSkipImmediate(t, "user"),
    userId,
    conversationId,
    debounceKey: `user:${userId}`,
  })) return;

  const parsed = await runImmediateClassifier(text, "user");
  if (parsed.length === 0) return;

  const confidence = detectConfidence(text);
  const groups = new Map();
  for (const f of parsed) {
    const sid = resolveSubjectId(f.subject, userId, userName, participants);
    if (!groups.has(sid)) groups.set(sid, []);
    groups.get(sid).push({ key: f.key, value: f.value, confidence });
  }

  for (const [subjectId, facts] of groups) {
    // The subject's own opt-out governs, not the author's.
    if (store.isIncognito(subjectId, conversationId)) continue;
    const result = await mergeUserFacts(subjectId, facts, text);
    if (result) {
      logger.debug(`[Facts] subject [${subjectId}] +${facts.length} by [${userId}] ${result.before}->${result.after}`);
    }
  }
}

async function extractImmediateContextFacts({ text, userId, conversationId }) {
  if (!IMMEDIATE_FACTS_ENABLED) return;
  if (!shouldExtract({
    label: `Facts conversation [${conversationId}]`,
    text,
    gate: t => !shouldSkipImmediate(t, "conversation"),
    userId,
    conversationId,
    debounceKey: `conversation:${conversationId}`,
  })) return;

  const parsed = await runImmediateClassifier(text, "conversation");
  if (parsed.length === 0) return;

  const confidence = detectConfidence(text);
  const context = store.getConversation(conversationId);
  const tagged = parsed.map(f => ({ ...f, confidence }));
  const pruned = sortAndPruneFacts(mergeFacts(context.facts || [], tagged, text));
  await store.updateConversation(conversationId, { facts: pruned });
  logger.debug(`[Facts] conversation [${conversationId}] +${parsed.length} -> ${pruned.length} total`);
  return tagged;
}

function resetDebounce() {
  _debounce.clear();
}

module.exports = {
  tokenizeValue, normalizeFactKey, detectConfidence, cleanupExpiredFacts,
  isCoreIdentityKey, scoreFacts, relevanceScore, buildCueTokens, cueSlice,
  buildFactsBlock, buildMultiUserFactsBlock,
  valueOverlapsExisting, mergeFacts, sortAndPruneFacts, compressFacts,
  runImmediateClassifier, resolveSubjectId, mergeUserFacts,
  extractImmediateUserFacts, extractImmediateContextFacts,
  shouldSkipImmediate, shouldExtract, resetDebounce,
};
