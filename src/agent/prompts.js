// System-prompt assembly.
//
// Section order is fixed and load-bearing, not stylistic. Providers cache
// prompts by matching prefix, so anything that changes every turn (the current
// time, who is speaking, the participant roster) must sit at the END. Move a
// volatile section above a stable one and the cache hit rate collapses —
// visible as the hit/miss ratio the router logs per variant.
//
// Order, most stable to most volatile:
//   1. Persona / behavioral rules for this conversation type
//   2. Topic / background
//   3. Identity rules
//   4. Standing directives (near-static per conversation — kept high for cache reuse)
//   5. Conversation facts
//   6. Conversation summary
//   7. User summary
//   8. User facts
//   9. Knowledge-base context (pre-flight retrieval for this turn)
//  10. Tool instructions
//  11. Perception block (attachments, fetched links)
//  12. Participant roster
//  13. Dynamic tail (time, current speaker, reply context)

function assembleSystemPrompt(parts) {
  return [
    parts.personaBlock,
    parts.topicBlock,
    parts.identityRulesBlock,
    parts.directivesBlock,
    parts.conversationFactsBlock,
    parts.conversationSummaryBlock,
    parts.userSummaryBlock,
    parts.userFactsBlock,
    parts.kbContextBlock,
    parts.toolBlock,
    parts.perceptionBlock,
    parts.participantsBlock,
    parts.dynamicTail,
  ].filter(Boolean).join("\n\n");
}

// Teaches the model to trust the [user_NNN] anchor over display names, which
// drift. Without this, a model in a multi-party conversation will merge two
// people who share a nickname, or split one person who renamed.
const IDENTITY_RULES_BLOCK = [
  "[Identity Rules]",
  "- The bracketed [user_NNN] prefix on each message is the ground-truth author identifier. Display names can change; the ID never does.",
  "- Facts are grouped per person under [UserFacts name=\"...\" id=\"...\"]. Attribute each fact only to the person whose block it appears in — never assume one person's facts belong to another.",
  "- When someone's facts contain previous_name=Y but they now speak under a different name, treat Y as that same person's former display name. Reconcile by ID, not by name.",
  "- Never argue with someone about their own identity or preferences. If they correct you, accept it immediately and do not reference the earlier mistake.",
  "",
  "[Memory Use]",
  "- Before asking for a detail, check the fact blocks above. If a stored fact plausibly answers it, use it instead of asking — asking for something you already know reads as forgetting.",
  "- When an image or link you are looking at shows something a stored fact covers (a pet, a project, a place), connect them: refer to it by the name you already have rather than asking what it is.",
  "- Recall confidently but never invent. If no fact covers it, ask — do not guess a name or detail that is not stored.",
].join("\n");

// Neutral default persona. Applications are expected to replace this with their
// own via AgentOptions.persona; it exists so the engine is useful out of the box
// rather than to prescribe a voice.
const DEFAULT_PERSONA = [
  "You are a helpful AI assistant participating in an ongoing conversation.",
  "",
  "[Guidelines]",
  "- Answer accurately and concisely. Match the scope of your response to the scope of the request.",
  "- Adapt tone and format to the conversation. Use Markdown where it aids readability.",
  "- Do not invent links, dates, figures, or private data. State uncertainty plainly rather than guessing.",
  "- If context is missing or ambiguous, ask one focused clarifying question or answer with your assumptions stated explicitly.",
  "- Do not mention your tools or internal capabilities unless the user asks about them. Use them silently.",
  "- Vary sentence rhythm and structure so replies do not read as templated.",
].join("\n");

// Perception framing. When a vision model has already described an image, the
// text agent must not narrate the seam ("based on the description you gave
// me") — from the user's perspective the assistant looked at the image.
const PERCEPTION_RULES = [
  "[Perception]",
  "- The content below is your own direct observation of what the user shared — an image you looked at, or a page you read.",
  "- Do not say \"based on the description\", \"according to the summary\", or anything implying you only received a text representation.",
  "- React naturally, as if you opened it yourself: comment on specific details with confidence.",
  "- Only if the block explicitly reports that content was UNAVAILABLE should you say you could not access it. Do not explain why it was unavailable.",
].join("\n");

function buildPerceptionBlock(perception) {
  if (!perception) return "";
  return `${PERCEPTION_RULES}\n\n${perception}`;
}

// Tool guidance. Generated from the registry so the routing hints and the
// registered tools cannot drift apart.
function buildToolBlock(registry, { citations = true } = {}) {
  if (!registry || registry.size() === 0) return "";
  const lines = [
    "[Tools] You have tools available. Use them silently when a request matches — do not name them to the user.",
  ];
  for (const name of registry.names()) {
    const description = registry.get(name).description.split(". ")[0];
    lines.push(`- ${name}: ${description}`);
  }
  if (registry.has("lookup_kb")) {
    lines.push(
      "If a [KnowledgeBase] block appears above, those entries were already retrieved for this turn — " +
      "answer from them directly and call lookup_kb only for a topic they do not cover.",
    );
  }
  if (citations && (registry.has("search_history") || registry.has("lookup_kb"))) {
    lines.push(
      "Citations: when your reply uses a search_history result, embed [[cite:msg:N]] (N = that result's result_index) " +
      "immediately after the relevant claim. When using a lookup_kb result, embed [[cite:kb:slug]]. " +
      "Each citation token may appear at most once — duplicates are stripped.",
    );
  }
  return lines.join("\n");
}

function buildTopicBlock(topic) {
  return topic && topic.trim() ? `[Topic]\n${topic.trim()}` : "";
}

// Everything that changes every turn, kept together at the tail so the prefix
// above stays byte-identical between turns.
function buildDynamicTail({ speakerName, replyContext, presentNames }) {
  const parts = [];
  if (replyContext) parts.push(replyContext);
  parts.push(`Current time: ${new Date().toISOString()}`);
  if (presentNames?.length) parts.push(`Currently present: ${presentNames.join(", ")}`);
  if (speakerName) parts.push(`You are currently speaking to ${speakerName}.`);
  return parts.join("\n");
}

module.exports = {
  assembleSystemPrompt,
  buildToolBlock,
  buildTopicBlock,
  buildPerceptionBlock,
  buildDynamicTail,
  IDENTITY_RULES_BLOCK,
  DEFAULT_PERSONA,
  PERCEPTION_RULES,
};
