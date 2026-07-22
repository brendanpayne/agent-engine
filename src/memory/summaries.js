// Rolling summarization and the memory tick.
//
// The tick is what makes memory autonomous: after each turn it increments
// counters and, at configured intervals, fires summarization, fact extraction,
// topic refresh, and archive ingestion. Nothing here blocks a reply — the agent
// loop calls tick() without awaiting it.
//
// Message shape throughout: { userId, userName, text, messageId, timestamp,
// isAgent } — the same normalized form the agent loop receives. No platform
// objects reach this layer.

const {
  CONVO_MODEL,
  MAX_SUMMARIES,
  MAX_FACTS,
  SUMMARY_INTERVAL,
  FACTS_INTERVAL,
  TOPIC_UPDATE_INTERVAL,
} = require("../../config.js");
const logger = require("../util/logger");
const llm = require("../llm");
const { chatWithSchema } = require("../schemas");
const store = require("./store");
const archive = require("../archive");
const jobs = require("../jobs");
const { mergeFacts, sortAndPruneFacts, compressFacts } = require("./facts");

function formatAgeLabel(timestamp) {
  if (!timestamp) return "0m";
  const ageMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (ageMinutes < 60) return `${ageMinutes}m`;
  if (ageMinutes < 1440) return `${Math.floor(ageMinutes / 60)}h`;
  return `${Math.floor(ageMinutes / 1440)}d`;
}

// Age is included so the model can weigh a stale summary appropriately rather
// than treating a three-day-old recap as current.
function buildSummaryBlock(tag, summaryObject) {
  if (!summaryObject?.context) return "";
  return `[${tag} age=${formatAgeLabel(summaryObject.timestamp)}]\n${summaryObject.context}`;
}

function formatTranscript(messages) {
  return messages
    .map(m => (m.isAgent ? `(You): ${m.text}` : `[user_${m.userId}] ${m.userName || "user"}: ${m.text}`))
    .join("\n");
}

function appendSummary(previous, context) {
  const summaryObject = {
    timestamp: Date.now(),
    context,
    mergedFrom: previous.length > 0 ? previous.length : undefined,
  };
  return { summaryObject, summaries: [...previous, summaryObject].slice(-MAX_SUMMARIES) };
}

// Every bullet must name who it is about. Without that instruction summaries
// collapse into "the user said…" and become useless in a multi-party thread —
// and worse, later turns misattribute preferences to whoever is speaking now.
async function summarizeConversation(conversationId, messages) {
  const context = store.getConversation(conversationId);
  const previous = context.summaries || [];
  const roster = Object.entries(context.participants || {})
    .map(([uid, p]) => `${p.currentName} (user_${uid})`).join(", ");

  const prompt = [
    "You are a memory compression assistant. Summarize this conversation in 4-6 concise bullet points, focusing on:",
    "- What the participants are trying to discuss or achieve",
    "- Important facts, preferences, decisions, requests, or instructions",
    "- Context worth remembering in future replies",
    "IMPORTANT: Every bullet point must explicitly name the relevant participant(s) (e.g. \"Alice decided to migrate the database\"). Never use \"the user\" or an unattributed \"they\". Keep personal preferences attributed to whoever stated them; record only shared plans and group decisions as conversation-wide facts.",
    roster && `Use each participant's CURRENT display name as listed here: ${roster}. If the previous summary refers to someone by an older name, rewrite it to their current name.`,
    messages?.length && `[Conversation]\n${formatTranscript(messages)}`,
    previous.length > 0 && `[Previous Summary]\n*Carry forward anything still relevant as a concise bullet point.*\n${previous[previous.length - 1].context}`,
    "[Summary]",
  ].filter(Boolean).join("\n");

  const res = await llm.chat({
    model: CONVO_MODEL,
    messages: [
      { role: "system", content: "You summarize conversations into useful memory, responding with only the summary body." },
      { role: "user", content: prompt },
    ],
    max_tokens: 1024,
    temperature: 0.3,
    timeoutMs: 30_000,
    label: "summarizeConversation",
    variant: "summarize_conversation",
  });

  const summary = res.result.content?.trim();
  if (!summary) throw new Error("Summarization returned no content");

  const { summaryObject, summaries } = appendSummary(previous, summary);
  await store.updateConversation(conversationId, { summaries });
  logger.info(`[Memory] Summarized conversation ${conversationId}`);
  return summaryObject;
}

async function summarizeUser(userId, userMessages) {
  const data = store.getUser(userId);
  const previous = data.summaries || [];

  const prompt = [
    "You are a memory assistant building a profile of a specific person from their messages.",
    "Summarize in 4-6 concise bullet points, focusing on:",
    "- Topics and subjects they return to",
    "- Their communication style, tone, and vocabulary",
    "- Opinions, preferences, or interests they have expressed",
    "- Personality traits observable from their messages",
    userMessages.length > 0 && `[Their Messages]\n${userMessages.map(m => `${m.userName || "user"}: ${m.text}`).join("\n")}`,
    previous.length > 0 && `[Previous Profile Summary]\n*Carry forward relevant info.*\n${previous[previous.length - 1].context}`,
    "[Profile Summary]",
  ].filter(Boolean).join("\n");

  const res = await llm.chat({
    model: CONVO_MODEL,
    messages: [
      { role: "system", content: "You build user profiles from chat messages, responding with only the summary body." },
      { role: "user", content: prompt },
    ],
    max_tokens: 1024,
    temperature: 0.3,
    timeoutMs: 30_000,
    label: "summarizeUser",
    variant: "summarize_user",
  });

  const summary = res.result.content?.trim();
  if (!summary) throw new Error("User summarization returned no content");

  const { summaryObject, summaries } = appendSummary(previous, summary);
  await store.updateUser(userId, { summaries });
  logger.info(`[Memory] Summarized user ${userId}`);
  return summaryObject;
}

// Distil the latest summary into structured facts. Runs on the summary rather
// than raw messages so extraction sees consolidated context, not chatter.
async function generateConversationFacts(conversationId) {
  const context = store.getConversation(conversationId);
  const existingFacts = context.facts || [];
  const summaries = context.summaries || [];
  const latestSummary = summaries.length > 0 ? summaries[summaries.length - 1].context : null;

  const prompt = [
    "You extract structured, permanent facts from conversation summaries.",
    "- Extract ONLY shared, group-level context: events, plans, recurring activities, topics, collective decisions.",
    "- NEVER extract personal preferences, hobbies, or identity traits of individuals. Those belong in user-level memory.",
    "- Avoid duplicates and anything vague or temporary. Normalize key names.",
    "- Respond with ONLY valid JSON matching the schema: {\"facts\": [{\"key\":\"...\",\"value\":\"...\",\"confidence\":\"high|low\"}]}.",
    latestSummary && `[Latest Summary]\n${latestSummary}`,
    existingFacts.length > 0 && `[Previously Known Facts — update or keep these]\n${existingFacts.map(f => `${f.key}=${f.value}`).join("\n")}`,
    "[New or Updated Facts]",
  ].filter(Boolean).join("\n");

  const res = await chatWithSchema({
    schemaName: "fact-extraction",
    model: CONVO_MODEL,
    messages: [
      { role: "system", content: "You extract permanent facts from a summary and write them to memory." },
      { role: "user", content: prompt },
    ],
    max_tokens: 1024,
    temperature: 0.3,
    timeoutMs: 60_000,
    label: "generateConversationFacts",
    variant: "facts_conversation",
  });

  const parsed = (res.validated?.facts || []).map(f => ({ ...f, confidence: f.confidence || "high" }));
  let combined = mergeFacts(existingFacts, parsed, latestSummary || "");
  // Compact before hitting the cap, not after — once facts are being dropped
  // by sortAndPruneFacts the information is already gone.
  if (combined.length >= MAX_FACTS - 3) {
    combined = await compressFacts(combined, "conversation");
  }
  combined = sortAndPruneFacts(combined);

  await store.updateConversation(conversationId, { facts: combined });
  logger.info(`[Memory] Conversation ${conversationId} now holds ${combined.length} facts`);
  return combined;
}

async function generateUserFacts(userId, userMessages) {
  const data = store.getUser(userId);
  const existingFacts = data.facts || [];
  const summaries = data.summaries || [];
  const latestSummary = summaries.length > 0 ? summaries[summaries.length - 1].context : null;

  const prompt = [
    "You extract structured facts about a specific person from their conversation summaries.",
    "- Focus on permanent personal attributes: personality traits, hobbies, opinions, preferences, communication style.",
    "- Avoid temporary or conversation-specific context; focus on who this person is.",
    "- Avoid duplicates and vague facts. Normalize key names.",
    "- Respond with ONLY valid JSON matching the schema: {\"facts\": [{\"key\":\"...\",\"value\":\"...\",\"confidence\":\"high|low\"}]}.",
    latestSummary && `[Latest Profile Summary]\n${latestSummary}`,
    existingFacts.length > 0 && `[Previously Known Facts — update or keep]\n${existingFacts.map(f => `${f.key}=${f.value}`).join("\n")}`,
    "[New or Updated Facts]",
  ].filter(Boolean).join("\n");

  const res = await chatWithSchema({
    schemaName: "fact-extraction",
    model: CONVO_MODEL,
    messages: [
      { role: "system", content: "You extract permanent facts about a person and write them to memory." },
      ...(userMessages.length > 0
        ? [{ role: "system", content: `Their recent messages:\n${userMessages.map(m => `${m.userName || "user"}: ${m.text}`).join("\n")}` }]
        : []),
      { role: "user", content: prompt },
    ],
    max_tokens: 1024,
    temperature: 0.3,
    timeoutMs: 60_000,
    label: "generateUserFacts",
    variant: "facts_user",
  });

  const parsed = (res.validated?.facts || []).map(f => ({ ...f, confidence: f.confidence || "high" }));
  let combined = mergeFacts(existingFacts, parsed, latestSummary || "", userId);
  if (combined.length >= MAX_FACTS - 3) {
    combined = await compressFacts(combined, "user", userId);
  }
  combined = sortAndPruneFacts(combined);

  await store.updateUser(userId, { facts: combined });
  logger.info(`[Memory] User ${userId} now holds ${combined.length} facts`);
  return combined;
}

// Returns a new topic string, or null when the subject has not meaningfully
// shifted — so an unchanged topic costs one cheap call rather than a rewrite.
async function generateTopic(conversationId, messages) {
  const context = store.getConversation(conversationId);
  const existingTopic = (context.topic || "").trim();
  const recent = (messages || []).slice(0, 5).map(m => m.text).filter(Boolean).join("\n");

  const prompt = [
    existingTopic
      ? `Current topic:\n${existingTopic}\n\nRecent messages:\n${recent}\n\nDecide whether the conversation has shifted significantly from the current topic. If it has, write a new concise topic (1-3 sentences). If it has NOT, respond with exactly: NO_CHANGE`
      : `Summarize the messages below into a short topic paragraph (1-3 sentences).\nMessages:\n${recent}`,
    "The topic should be concise and informative. Focus on the main idea. Do not mention the messages or that you are an AI assistant.",
  ].join("\n");

  const res = await llm.chat({
    model: CONVO_MODEL,
    messages: [
      { role: "system", content: "You organize and summarize discussions. When updating a topic, only do so if the subject matter has genuinely shifted." },
      { role: "user", content: prompt },
    ],
    max_tokens: 512,
    temperature: 0.3,
    timeoutMs: 30_000,
    label: "generateTopic",
    variant: "topic",
  });

  const result = res.result.content?.trim() || "";
  if (existingTopic && result.toUpperCase() === "NO_CHANGE") return null;
  return result;
}

// Write messages into the searchable archive and enqueue one batched embedding
// job. Batching at summary boundaries is what keeps embedding cost proportional
// to conversation milestones rather than raw message volume.
function archiveMessages(conversationId, messages) {
  if (!messages || messages.length === 0) return;
  const insertedIds = [];
  for (const m of messages) {
    if (!m?.messageId || !m.userId || !m.text) continue;
    const id = archive.insertChunk({
      conversationId,
      messageId: m.messageId,
      authorId: m.userId,
      content: m.text,
      createdAt: m.timestamp || Date.now(),
    });
    if (id) insertedIds.push(id);
  }
  if (insertedIds.length > 0) {
    jobs.enqueue({
      kind: "message_embed",
      payload: { conversationId, chunkIds: insertedIds },
      run_at: Date.now(),
    });
    logger.info(`[Archive] Inserted ${insertedIds.length} chunks for ${conversationId}, enqueued embedding job.`);
  }
}

// Advance the memory counters and fire whichever tier is due.
//
// Exactly one tier runs per turn. Summarization implies fact extraction, so
// when a summary fires the facts counter resets too — running both in the same
// turn as a separate facts pass would double-charge for the same content.
async function tick(conversationId, messages, userId, { onTopicChange } = {}) {
  const context = store.getConversation(conversationId);
  const summaryCount = (context.messagesSinceSummary ?? 0) + 1;
  const factsCount = (context.messagesSinceFacts ?? 0) + 1;
  const topicCount = (context.messagesSinceTopic ?? 0) + 1;

  if (summaryCount >= SUMMARY_INTERVAL) {
    await store.updateConversation(conversationId, {
      messagesSinceSummary: 0, messagesSinceFacts: 0, messagesSinceTopic: topicCount,
    });
    logger.info(`[MemoryTick] Summarizing ${conversationId} after ${SUMMARY_INTERVAL} messages.`);
    try {
      await summarizeConversation(conversationId, messages);
      await generateConversationFacts(conversationId);
    } catch (err) {
      logger.error(`[MemoryTick] Summarization failed for ${conversationId}: ${err.message}`);
    }
    try {
      archiveMessages(conversationId, messages);
    } catch (err) {
      logger.error(`[MemoryTick] Archive failed for ${conversationId}: ${err.message}`);
    }
  } else if (factsCount >= FACTS_INTERVAL) {
    await store.updateConversation(conversationId, {
      messagesSinceSummary: summaryCount, messagesSinceFacts: 0, messagesSinceTopic: topicCount,
    });
    try {
      await generateConversationFacts(conversationId);
    } catch (err) {
      logger.error(`[MemoryTick] Fact generation failed for ${conversationId}: ${err.message}`);
    }
  } else if (topicCount >= TOPIC_UPDATE_INTERVAL && context.topic) {
    try {
      const newTopic = await generateTopic(conversationId, messages);
      await store.updateConversation(conversationId, {
        ...(newTopic ? { topic: newTopic } : {}),
        messagesSinceTopic: 0, messagesSinceSummary: summaryCount, messagesSinceFacts: factsCount,
      });
      if (newTopic && typeof onTopicChange === "function") {
        // Best-effort host notification; a failing callback must not fail the tick.
        try { await onTopicChange(newTopic); }
        catch (err) { logger.warn(`[MemoryTick] onTopicChange failed: ${err.message}`); }
      }
    } catch (err) {
      logger.error(`[MemoryTick] Topic generation failed for ${conversationId}: ${err.message}`);
      await store.updateConversation(conversationId, {
        messagesSinceTopic: 0, messagesSinceSummary: summaryCount, messagesSinceFacts: factsCount,
      });
    }
  } else {
    await store.updateConversation(conversationId, {
      messagesSinceSummary: summaryCount, messagesSinceFacts: factsCount, messagesSinceTopic: topicCount,
    });
  }

  if (!userId) return;
  if (store.isIncognito(userId, conversationId)) {
    logger.debug(`[MemoryTick] User ${userId} is incognito; skipping user memory update.`);
    return;
  }

  const data = store.getUser(userId);
  const userSummaryCount = (data.messagesSinceSummary ?? 0) + 1;
  const userFactsCount = (data.messagesSinceFacts ?? 0) + 1;
  const messageCount = (data.messageCount ?? 0) + 1;
  const userMessages = (messages || []).filter(m => m.userId === userId && !m.isAgent);

  if (userSummaryCount >= SUMMARY_INTERVAL) {
    await store.updateUser(userId, { messageCount, messagesSinceSummary: 0, messagesSinceFacts: 0 });
    try {
      await summarizeUser(userId, userMessages);
      await generateUserFacts(userId, userMessages);
    } catch (err) {
      logger.error(`[MemoryTick] User summarization failed for ${userId}: ${err.message}`);
    }
  } else if (userFactsCount >= FACTS_INTERVAL) {
    await store.updateUser(userId, { messageCount, messagesSinceSummary: userSummaryCount, messagesSinceFacts: 0 });
    try {
      await generateUserFacts(userId, userMessages);
    } catch (err) {
      logger.error(`[MemoryTick] User fact generation failed for ${userId}: ${err.message}`);
    }
  } else {
    await store.updateUser(userId, {
      messageCount, messagesSinceSummary: userSummaryCount, messagesSinceFacts: userFactsCount,
    });
  }
}

module.exports = {
  buildSummaryBlock, formatAgeLabel,
  summarizeConversation, summarizeUser,
  generateConversationFacts, generateUserFacts,
  generateTopic, archiveMessages, tick,
};
