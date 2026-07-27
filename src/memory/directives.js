// Standing directives: persistent behavioral rules for a conversation ("never
// spoil the answer to a puzzle, give hints instead"). They are deliberately NOT
// facts — facts expire on a TTL, compete for prompt slots by score, and get
// merged by the compressor, all of which would silently drop a rule the user
// expects to hold indefinitely. Directives have their own store, no TTL, and an
// always-on prompt slot.
//
// Two ways in: the model calls set_directive/remove_directive explicitly, or
// the keyword-gated classifier below catches a rule stated in passing. The
// classifier exists because users state rules conversationally and never think
// to ask the agent to remember them.

const {
  MAX_DIRECTIVES,
  DIRECTIVE_MAX_LENGTH,
  DIRECTIVES_ENABLED,
  CONVO_MODEL,
} = require("../../config.js");
const logger = require("../util/logger");
const { withLock } = require("../util/lock");
const { tokenize, jaccard, containsAllTokens } = require("../util/text");
const { chatWithSchema } = require("../schemas");
const store = require("./store");
const facts = require("./facts");

const similarity = jaccard;

// Above this, two rules are the same rule worded differently and the existing
// entry is refreshed rather than a second copy stacked alongside it.
const DUPLICATE_THRESHOLD = 0.7;

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, DIRECTIVE_MAX_LENGTH || 300);
}

// Short random id rather than an index so removal stays stable across
// additions and removals. Padded because Math.random().toString(36) is short
// when the value has a short base-36 expansion — a 1-character id collides
// easily and would make removal ambiguous.
const ID_LENGTH = 6;

function makeId() {
  let id = "";
  while (id.length < ID_LENGTH) {
    id += Math.random().toString(36).slice(2);
  }
  return id.slice(0, ID_LENGTH);
}

// Returns { directives, added, reinforced, dropped }. Near-duplicates refresh
// the existing entry instead of stacking a second copy of the same rule.
function mergeDirectives(existing, incoming, meta = {}) {
  const now = meta.now ?? Date.now();
  const directives = Array.isArray(existing)
    ? existing.filter(Boolean).map(d => ({ ...d }))
    : [];
  const added = [];
  const reinforced = [];

  for (const raw of Array.isArray(incoming) ? incoming : []) {
    const text = normalizeText(typeof raw === "string" ? raw : raw?.text);
    if (text.length < 4) continue;

    const match = directives.find(d => similarity(d.text, text) >= DUPLICATE_THRESHOLD);
    if (match) {
      match.updatedAt = now;
      reinforced.push(match.id);
      continue;
    }

    const entry = {
      id: makeId(),
      text,
      createdBy: meta.createdBy || null,
      createdAt: now,
      updatedAt: now,
      source: meta.source || "manual",
    };
    directives.push(entry);
    added.push(entry);
  }

  // Oldest-first eviction. A rule set long ago and never restated is the one
  // most likely to be stale.
  const cap = MAX_DIRECTIVES || 10;
  let dropped = [];
  if (directives.length > cap) {
    dropped = directives.slice(0, directives.length - cap);
    directives.splice(0, directives.length - cap);
  }

  return { directives, added, reinforced, dropped };
}

// Accepts an id or the directive text itself, so the model can retract a rule
// it only knows by wording. Returns { directives, removed }.
//
// Matching widens in decreasing order of certainty. The containment pass
// matters most in practice: callers name a rule by a fragment ("spoilers"),
// and against a full sentence that scores far below any usable Jaccard
// threshold, so similarity alone would silently fail to remove anything.
function removeDirective(existing, idOrText) {
  const directives = Array.isArray(existing) ? existing.filter(Boolean) : [];
  const needle = String(idOrText || "").trim();
  if (!needle) return { directives, removed: null };

  const lowered = needle.toLowerCase();
  const matchers = [
    d => d.id === needle,
    d => d.text.toLowerCase() === lowered,
    d => containsAllTokens(d.text, needle),
    d => similarity(d.text, needle) >= DUPLICATE_THRESHOLD,
  ];

  let idx = -1;
  for (const match of matchers) {
    idx = directives.findIndex(match);
    if (idx !== -1) break;
  }
  if (idx === -1) return { directives, removed: null };

  const [removed] = directives.splice(idx, 1);
  return { directives, removed };
}

function buildDirectivesBlock(directives) {
  const list = Array.isArray(directives) ? directives.filter(d => d && d.text) : [];
  if (list.length === 0) return "";

  const body = list.map((d, i) => `${i + 1}. (${d.id}) ${d.text}`).join("\n");
  return [
    "[Standing Instructions]",
    "These are binding rules this conversation has asked you to follow. They persist indefinitely — across days, restarts, and context resets — until someone explicitly retracts one.",
    "- Follow them even when a later request conflicts. If someone directly asks for something a standing instruction forbids, honor the instruction and offer what it does allow instead.",
    "- Never claim you forgot or were not told. If someone retracts one, acknowledge it and stop applying it.",
    body,
  ].join("\n");
}

// Gate for the directive classifier. Standing rules are almost always phrased
// with an absolute or a temporal-scope marker; everything else skips the call.
// Bare "never" and "always" are among the most common words in casual chat
// ("I always lose at this", "never mind"), so gating on them alone would put an
// LLM call on the majority of messages. Every alternative here requires a scope
// marker or a verb describing something the AGENT does.
// Stems plus an inflection suffix, with the silent-e verbs spelled out so
// "stop posting", "never telling", and "always giving" all match.
const DIRECTIVE_VERB = "(?:tell|say|said|reveal|spoil|post|mention|answer|ask|remind|add|start|end|respond|call|show|reply|replie|bring up|giv|shar|us|includ)(?:e|es|s|ed|ing)?";
const DIRECTIVE_KEYWORDS = new RegExp([
  "\\b(?:from now on|going forward|in future|from here on)\\b",
  `\\b(?:never|always|no longer|don'?t ever|do not ever|stop|quit)\\s+(?:\\w+\\s+){0,2}${DIRECTIVE_VERB}\\b`,
  `\\b(?:remember|make sure) to\\s+(?:\\w+\\s+){0,2}${DIRECTIVE_VERB}\\b`,
  `\\bevery time\\b.*\\b${DIRECTIVE_VERB}\\b`,
  `\\bwhenever (?:i|we|someone)\\b.*\\b${DIRECTIVE_VERB}\\b`,
  "\\b(?:forget|drop|cancel|nevermind) (?:that|the|this) rule\\b",
  "\\byou can (?:now|again)\\b",
].join("|"), "i");

const CLASSIFIER_PROMPT = [
  "Extract STANDING INSTRUCTIONS directed at an AI assistant: durable rules about how it should behave from now on.",
  "Respond with ONLY valid JSON matching the schema: {\"directives\": [{\"instruction\":\"...\",\"action\":\"add|remove\"}]}.",
  "Empty directives array if the message contains none.",
  "An instruction qualifies only if it is addressed to the assistant AND is meant to persist beyond the current message.",
  "Rewrite each one as a short imperative rule in the third person, e.g. \"Never reveal the answer to word games; give hints only when asked directly.\"",
  "Use action=remove when the speaker is cancelling a rule they set earlier.",
  "DO NOT extract: one-off requests, personal facts, preferences about themselves, opinions, jokes, or anything phrased as a single-turn ask.",
  "",
  "Examples:",
  "\"never spoil the puzzle answer, just give hints if i ask\" -> add: \"Never reveal puzzle answers; give hints only when asked directly.\"",
  "\"from now on keep your replies under 3 sentences\" -> add: \"Keep replies under three sentences.\"",
  "\"you can talk about spoilers again\" -> remove: \"Do not discuss spoilers.\"",
  "\"never mind, tell me the answer\" -> (empty)",
  "\"i never eat breakfast\" -> (empty)",
].join("\n");

async function runDirectiveClassifier(text) {
  const res = await chatWithSchema({
    schemaName: "directive-extraction",
    model: CONVO_MODEL,
    messages: [
      { role: "system", content: CLASSIFIER_PROMPT },
      { role: "user", content: text },
    ],
    max_tokens: 250,
    temperature: 0,
    timeoutMs: 20_000,
    label: "immediate-directive",
    variant: "immediate_directive",
  });

  if (res.validated?.directives) {
    return res.validated.directives.filter(d => d.instruction && d.action);
  }
  logger.warn(`[Directives] classifier schema failed: ${res.schemaError || "no output"}`);
  return [];
}

// Directives live on the conversation, not the speaker: a rule set by one
// participant applies to the whole room, which is how a shared conversation
// actually works.
//
// Debounced per speaker rather than per conversation — a conversation-wide
// bucket lets one participant's message swallow another's rule, and unlike
// facts (which the periodic summary pass re-extracts) a dropped directive is
// never revisited.
async function extractStandingDirectives({ text, userId, conversationId }) {
  if (!DIRECTIVES_ENABLED) return;
  if (!facts.shouldExtract({
    label: `Directives conversation [${conversationId}]`,
    text,
    gate: t => DIRECTIVE_KEYWORDS.test(t),
    userId,
    conversationId,
    debounceKey: `directive:${conversationId}:${userId}`,
  })) return;

  const parsed = await runDirectiveClassifier(text);
  if (parsed.length === 0) {
    logger.debug(`[Directives] conversation [${conversationId}] classifier returned 0 directives`);
    return;
  }

  return withLock(`directives:${conversationId}`, async () => {
    const context = store.getConversation(conversationId);
    let directives = Array.isArray(context.directives) ? context.directives : [];

    const toRemove = parsed.filter(d => d.action === "remove");
    for (const d of toRemove) {
      const res = removeDirective(directives, d.instruction);
      directives = res.directives;
      if (res.removed) logger.info(`[Directives] Removed "${res.removed.text}" from ${conversationId}`);
    }

    const toAdd = parsed.filter(d => d.action === "add").map(d => d.instruction);
    const merged = mergeDirectives(directives, toAdd, { createdBy: userId || null, source: "auto" });

    if (merged.added.length === 0 && merged.reinforced.length === 0 && toRemove.length === 0) return;
    await store.updateConversation(conversationId, { directives: merged.directives });
    logger.info(`[Directives] conversation [${conversationId}] +${merged.added.length} added, ${merged.reinforced.length} reinforced, ${toRemove.length} removal(s) — now ${merged.directives.length}`);
    return merged.directives;
  });
}

module.exports = {
  mergeDirectives, removeDirective, buildDirectivesBlock,
  runDirectiveClassifier, extractStandingDirectives,
  similarity, tokenize, DIRECTIVE_KEYWORDS,
};
