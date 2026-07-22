// The agent loop: context assembly -> model call -> tool dispatch -> guards ->
// critique -> memory tick.
//
// The entire loop speaks one input shape (see AgentInput below) and returns one
// output shape. Nothing in this file knows what platform the message came from,
// which is the property that makes the engine embeddable anywhere.
//
// Reliability posture is fail-open throughout: memory reads, tool failures,
// citation expansion, and critique all degrade to a reply rather than an
// exception. The only thing that must never happen is a user getting silence.

const {
  CONVO_MODEL,
  PAST_MESSAGES,
  MAX_API_MESSAGES,
  CHAT_MAX_PROMPT_TOKENS,
  MAX_TOOL_DEPTH,
  LOW_BUDGET_MODE,
  STREAMING_ENABLED,
  INCLUDE_CHANNEL_FACTS_IN_PROMPT,
  INCLUDE_USER_FACTS_IN_PROMPT,
  IMMEDIATE_FACTS_ENABLED,
} = require("../../config.js");
const logger = require("../util/logger");
const llm = require("../llm");
const { estimateTokenCount } = require("../llm/cost");
const memoryStore = require("../memory/store");
const facts = require("../memory/facts");
const summaries = require("../memory/summaries");
const participantsModule = require("../memory/participants");
const { ToolRegistry, executeToolCall } = require("./tools/registry");
const { BUILTIN_TOOLS } = require("./tools/builtin");
const prompts = require("./prompts");
const critique = require("./critique");
const {
  createCitationStore, collectCitations, applyCitations, stripUnresolvedCitations,
} = require("./citations");

/**
 * @typedef {Object} AgentInput
 * @property {string}  userId          Stable identifier for the speaker.
 * @property {string}  [userName]      Display name (may change between turns).
 * @property {string}  conversationId  Stable identifier for the conversation.
 * @property {string}  [conversationName]
 * @property {string}  [scopeId]       Knowledge-base partition (workspace/tenant).
 * @property {string}  text            The user's message.
 * @property {string}  [messageId]
 * @property {number}  [timestamp]
 * @property {Array}   [attachments]   [{ url, contentType, name }]
 * @property {Array}   [participants]  [{ id, name }] seen recently.
 * @property {string}  [perception]    Pre-resolved image/link content.
 * @property {string}  [replyContext]  What this message is replying to.
 * @property {Object}  [metadata]      Host passthrough; never inspected here.
 */

// Merge streamed tool-call deltas. Providers send a tool call across many
// chunks — the name arrives once, arguments accumulate character by character.
function accumulateToolCalls(existing, deltas) {
  if (!existing) existing = [];
  for (const d of deltas) {
    const idx = d.index ?? 0;
    if (!existing[idx]) {
      existing[idx] = {
        id: d.id || "",
        type: d.type || "function",
        function: { name: d.function?.name || "", arguments: d.function?.arguments || "" },
      };
    } else {
      if (d.id) existing[idx].id = d.id;
      if (d.type) existing[idx].type = d.type;
      if (d.function?.name) existing[idx].function.name = d.function.name;
      if (d.function?.arguments) existing[idx].function.arguments += d.function.arguments;
    }
  }
  return existing;
}

// Some providers occasionally emit tool calls as inline markup in message
// content instead of populating the structured tool_calls field. Parse them out
// so the loop can handle them normally rather than showing the user raw markup.
function parseInlineToolCalls(content) {
  if (!content || !content.includes("DSML")) return [];
  const toolCalls = [];
  const invokeRe = /<[^<>\s]*DSML[^<>\s]*invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/[^<>\s]*DSML[^<>\s]*invoke>/g;
  const paramRe = /<[^<>\s]*DSML[^<>\s]*parameter\s+name="([^"]+)"\s+string="(true|false)"[^>]*>([\s\S]*?)<\/[^<>\s]*DSML[^<>\s]*parameter>/g;
  let invokeMatch;
  while ((invokeMatch = invokeRe.exec(content)) !== null) {
    const [, name, body] = invokeMatch;
    const args = {};
    let paramMatch;
    paramRe.lastIndex = 0;
    while ((paramMatch = paramRe.exec(body)) !== null) {
      const [, paramName, isString, value] = paramMatch;
      try { args[paramName] = isString === "true" ? value : JSON.parse(value); }
      catch (_) { args[paramName] = value; }
    }
    toolCalls.push({
      id: `inline_${Date.now()}_${toolCalls.length}`,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    });
  }
  return toolCalls;
}

// Ordered, de-duplicated ids of everyone present this turn: the speaker first,
// then whoever else spoke in the window. Anchors per-participant facts.
function presentMemberIds(input, history) {
  const ids = [input.userId];
  for (const m of history || []) {
    if (!m.isAgent && m.userId && !ids.includes(m.userId)) ids.push(m.userId);
  }
  return ids;
}

// Load facts for everyone present, skipping anyone who opted out. Reads are
// independent, so they run in parallel rather than serially.
async function loadParticipantFacts(participantIds, conversationId) {
  const perUserFacts = {};
  await Promise.all(participantIds.map(uid => {
    if (memoryStore.isIncognito(uid, conversationId)) return null;
    const data = memoryStore.getUser(uid);
    if (Array.isArray(data.facts) && data.facts.length > 0) perUserFacts[uid] = data.facts;
    return null;
  }));
  return perUserFacts;
}

// Build the system prompt plus the conversation history array.
async function assembleContext(input, options, registry) {
  const conversationId = input.conversationId;
  const context = memoryStore.getConversation(conversationId, input.conversationName);
  const history = (options.history || []).slice(0, PAST_MESSAGES);

  // Refresh the identity registry from everyone seen this turn.
  let participantsMap = context.participants || {};
  const seen = new Map([[input.userId, input.userName || "user"]]);
  for (const p of input.participants || []) {
    if (p?.id && p.name) seen.set(p.id, p.name);
  }
  for (const m of history) {
    if (!m.isAgent && m.userId && m.userName) seen.set(m.userId, m.userName);
  }
  try {
    participantsMap = await participantsModule.updateParticipants(
      conversationId,
      [...seen].map(([userId, displayName]) => ({ userId, displayName })),
    );
  } catch (err) {
    logger.warn(`[Identity] updateParticipants failed: ${err.message}`);
  }

  // --- Memory blocks -------------------------------------------------------
  let conversationFactsBlock = "";
  let conversationSummaryBlock = "";
  let userSummaryBlock = "";
  let userFactsBlock = "";

  if (INCLUDE_CHANNEL_FACTS_IN_PROMPT && context.facts?.length) {
    conversationFactsBlock = facts.buildFactsBlock("ConversationFacts", context.facts);
  }
  if (context.summaries?.length) {
    conversationSummaryBlock = summaries.buildSummaryBlock(
      "ConversationSummary", context.summaries[context.summaries.length - 1],
    );
  }

  const participantIds = presentMemberIds(input, history);
  if (INCLUDE_USER_FACTS_IN_PROMPT) {
    const speakerData = memoryStore.getUser(input.userId);
    if (speakerData.summaries?.length) {
      userSummaryBlock = summaries.buildSummaryBlock(
        `UserSummary name="${input.userName || "user"}"`,
        speakerData.summaries[speakerData.summaries.length - 1],
      );
    }
    const perUserFacts = await loadParticipantFacts(participantIds, conversationId);
    const nameOf = uid => participantsMap[uid]?.currentName
      || (uid === input.userId ? input.userName : null);
    userFactsBlock = facts.buildMultiUserFactsBlock(input.userId, participantIds, perUserFacts, nameOf);
  }

  const presentNames = participantIds
    .map(uid => participantsMap[uid]?.currentName)
    .filter(Boolean);

  const systemPrompt = prompts.assembleSystemPrompt({
    personaBlock: options.persona || context.persona?.systemPrompt || prompts.DEFAULT_PERSONA,
    topicBlock: prompts.buildTopicBlock(context.topic),
    identityRulesBlock: prompts.IDENTITY_RULES_BLOCK,
    conversationFactsBlock,
    conversationSummaryBlock,
    userSummaryBlock,
    userFactsBlock,
    toolBlock: prompts.buildToolBlock(registry),
    perceptionBlock: prompts.buildPerceptionBlock(input.perception),
    participantsBlock: participantsModule.buildParticipantsBlock(participantsMap, participantIds),
    dynamicTail: prompts.buildDynamicTail({
      speakerName: input.userName,
      replyContext: input.replyContext,
      presentNames,
    }),
  });

  // --- Conversation history ------------------------------------------------
  // Oldest first, as the chat API expects.
  const conversationHistory = [];
  for (const m of [...history].reverse()) {
    conversationHistory.push(m.isAgent
      ? { role: "assistant", content: m.text }
      : { role: "user", content: `[user_${m.userId}] ${m.userName || "user"}: ${m.text}` });
  }
  if (conversationHistory.length > MAX_API_MESSAGES) {
    conversationHistory.splice(0, conversationHistory.length - MAX_API_MESSAGES);
  }

  let userPrompt = `[user_${input.userId}] ${input.userName || "user"}: ${input.text}`;
  if (input.perception) userPrompt += `\n\n[Perception]\n${input.perception}`;

  return { systemPrompt, conversationHistory, userPrompt, context, participantsMap, participantIds };
}

// Drop oldest history until the estimated prompt fits the budget. The system
// prompt and the current message are never trimmed — losing the question to fit
// the context is self-defeating. A floor of 4 messages keeps the immediate
// back-and-forth intact.
function trimToTokenBudget(systemPrompt, conversationHistory, userPrompt) {
  if (!CHAT_MAX_PROMPT_TOKENS) return conversationHistory;

  const render = history => [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: userPrompt },
  ].map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");

  let estimate = estimateTokenCount(render(conversationHistory));
  if (estimate <= CHAT_MAX_PROMPT_TOKENS) return conversationHistory;

  logger.warn(`[PromptTrim] Prompt estimated at ${estimate} tokens, trimming to ${CHAT_MAX_PROMPT_TOKENS}.`);
  const MIN_HISTORY_MESSAGES = 4;
  const trimmed = [...conversationHistory];
  while (trimmed.length > MIN_HISTORY_MESSAGES) {
    trimmed.shift();
    estimate = estimateTokenCount(render(trimmed));
    if (estimate <= CHAT_MAX_PROMPT_TOKENS) break;
  }
  logger.debug(`[PromptTrim] ${conversationHistory.length} -> ${trimmed.length} messages, ~${estimate} tokens.`);
  return trimmed;
}

// Stream a first attempt. Returns { streamed, text, toolCalls }. If the model
// asks for tools mid-stream we abandon streaming and hand the calls back — the
// caller replays them through the non-streamed path.
async function streamAttempt(messages, variant, sink) {
  let accumulated = "";
  let reasoning = "";
  let pendingToolCalls = null;

  try {
    const stream = llm.chatStream({
      model: CONVO_MODEL,
      messages,
      temperature: 0.9,
      timeoutMs: 120_000,
      label: "agent",
      variant,
    });

    for await (const chunk of stream) {
      if (chunk.tool_calls?.length) {
        pendingToolCalls = accumulateToolCalls(pendingToolCalls, chunk.tool_calls);
      }
      if (chunk.content) {
        accumulated += chunk.content;
        if (typeof sink.onChunk === "function") {
          await sink.onChunk(chunk.content, accumulated);
        }
      }
      if (chunk.reasoning_content) reasoning += chunk.reasoning_content;
      if (chunk.finish_reason === "tool_calls") break;
    }

    if (pendingToolCalls?.length) {
      logger.debug("[Stream] Model requested tools mid-stream; switching to non-streamed path.");
      if (typeof sink.onAbort === "function") await sink.onAbort();
      return { streamed: false, text: null, toolCalls: pendingToolCalls, reasoning };
    }

    return { streamed: true, text: accumulated, toolCalls: null, reasoning };
  } catch (err) {
    // Streaming is an optimization. A failure falls back to a normal call.
    logger.warn(`[Stream] Streaming failed, falling back: ${err.message}`);
    if (typeof sink.onAbort === "function") await sink.onAbort();
    return { streamed: false, text: null, toolCalls: null, reasoning };
  }
}

// Run one batch of tool calls and append the results to the message array.
async function dispatchToolCalls(registry, toolCalls, messages, ctx, citationStore, accumulator) {
  for (const toolCall of toolCalls) {
    const result = await executeToolCall(registry, toolCall, ctx);
    collectCitations(toolCall.function.name, result, citationStore);
    accumulator.push({ tool: toolCall.function.name, args: toolCall.function.arguments, result });
    messages.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify(result) });
  }
}

// Output guards. Each strips a specific failure mode observed in practice.
function applyGuards(response, { toolResults, userText, hasAttachments }) {
  if (!response) return response;

  // 1. Hallucinated attachment markup. Models narrate "[Attached: image.png]"
  //    instead of calling the image tool.
  const beforeMarkup = response;
  response = response.replace(/\[Attached:.*?\]/gi, "").trim();
  if (response !== beforeMarkup) logger.warn("[Guard] Stripped hallucinated attachment markup.");

  // 2. Unverified URLs. If no web tool ran this turn, any URL the model
  //    produced was generated from memory, not retrieved — and generated URLs
  //    are usually plausible-looking 404s. Echoing a URL the user supplied is
  //    safe, so those survive.
  const webToolUsed = toolResults.some(r => r.tool === "web_search" || r.tool === "fetch_page");
  if (!webToolUsed) {
    const URL_RE = /https?:\/\/[^\s\]>)"]+/g;
    const found = response.match(URL_RE);
    if (found) {
      const hallucinated = found.filter(u => !(userText || "").includes(u));
      if (hallucinated.length > 0) {
        response = response.replace(URL_RE, u => ((userText || "").includes(u) ? u : ""))
          .replace(/\s{2,}/g, " ").trim();
        logger.warn(`[Guard] Stripped ${hallucinated.length} unverified URL(s): ${hallucinated.join(", ")}`);
      }
    }
  }

  // 3. Leaked provider markup that the inline parser did not consume.
  if (response.includes("DSML")) {
    logger.error("[Guard] Provider markup detected in final response — stripping.");
    response = response.replace(/<[^<>]*DSML[\s\S]*?<\/[^<>]*DSML[^<>]*>/g, "").trim();
  }

  if (!response && hasAttachments) return "";
  return response;
}

/**
 * Run one agent turn.
 *
 * @param {AgentInput} input
 * @param {Object} [options]
 * @param {ToolRegistry} [options.registry]      Defaults to the built-in tool set.
 * @param {Array}  [options.history]             Prior turns, newest first.
 * @param {string} [options.persona]             Overrides the default persona block.
 * @param {Object} [options.stream]              { onChunk, onAbort } to stream tokens.
 * @param {Object} [options.citationFormatters]  { msg(ref), kb(ref) } renderers.
 * @param {Function} [options.onProposal]        Called with a pending KB proposal.
 * @param {boolean}  [options.updateMemory=true] Run the background memory tick.
 * @returns {Promise<{text, attachments, toolCalls, usage, streamed}>}
 */
async function run(input, options = {}) {
  if (!input?.userId || !input?.conversationId) {
    throw new Error("AgentInput requires userId and conversationId.");
  }

  const registry = options.registry || defaultRegistry();
  const {
    systemPrompt, conversationHistory, userPrompt, participantsMap,
  } = await assembleContext(input, options, registry);

  const trimmedHistory = trimToTokenBudget(systemPrompt, conversationHistory, userPrompt);
  const messages = [
    { role: "system", content: systemPrompt },
    ...trimmedHistory,
    { role: "user", content: userPrompt },
  ];

  const ctx = {
    input,
    attachments: [],
    queryCache: new Map(),
    onProposal: options.onProposal,
    memory: memoryStore,
    logger,
  };
  const citationStore = createCitationStore();
  const toolResults = [];
  const toolDefinitions = registry.definitions();

  let response = null;
  let streamed = false;
  let usage = null;
  let depth = 0;
  const maxDepth = options.maxToolDepth || (LOW_BUDGET_MODE ? 2 : MAX_TOOL_DEPTH);

  try {
    while (depth < maxDepth) {
      // On the last iteration, omit tools entirely. Left available, a model
      // that has been calling tools will call another one and run out of budget
      // with nothing synthesized; removing them forces an answer.
      const finalSlot = depth === maxDepth - 1;

      // Stream only the first call, and only when nothing is queued for
      // attachment — a streamed reply cannot retroactively gain a file.
      if (STREAMING_ENABLED && !LOW_BUDGET_MODE && options.stream
          && depth === 0 && ctx.attachments.length === 0) {
        const streamRes = await streamAttempt(messages, options.variant || "default", options.stream);
        if (streamRes.streamed) {
          response = streamRes.text;
          streamed = true;
          break;
        }
        if (streamRes.toolCalls?.length) {
          messages.push({
            role: "assistant",
            content: null,
            tool_calls: streamRes.toolCalls,
            ...(streamRes.reasoning ? { reasoning_content: streamRes.reasoning } : {}),
          });
          await dispatchToolCalls(registry, streamRes.toolCalls, messages, ctx, citationStore, toolResults);
          depth++;
          continue;
        }
      }

      const completion = await llm.chat({
        model: CONVO_MODEL,
        messages,
        temperature: 0.9,
        ...(finalSlot ? {} : { tools: toolDefinitions, tool_choice: "auto" }),
        timeoutMs: 120_000,
        label: "agent",
        variant: options.variant || "default",
      });
      usage = completion.usage;
      const result = completion.result;

      if (result.finish_reason === "tool_calls" && result.tool_calls?.length) {
        messages.push({ role: "assistant", content: result.content || null, tool_calls: result.tool_calls });
        await dispatchToolCalls(registry, result.tool_calls, messages, ctx, citationStore, toolResults);
        depth++;
        continue;
      }

      response = result.content;

      const inlineToolCalls = parseInlineToolCalls(response);
      if (inlineToolCalls.length > 0) {
        logger.warn(`[Tools] ${inlineToolCalls.length} tool call(s) found inline in content — re-routing.`);
        messages.push({ role: "assistant", content: null, tool_calls: inlineToolCalls });
        await dispatchToolCalls(registry, inlineToolCalls, messages, ctx, citationStore, toolResults);
        depth++;
        continue;
      }

      // Reasoning models sometimes put the whole answer in reasoning_content and
      // leave content empty. Better to surface the reasoning than say nothing.
      if (!response?.trim() && result.reasoning_content?.trim()) {
        logger.warn("[Recover] Empty content with populated reasoning — using reasoning as the reply.");
        response = result.reasoning_content.trim();
      }

      logger.debug(`[Agent] usage prompt=${usage?.prompt_tokens ?? 0} completion=${usage?.completion_tokens ?? 0} cost=$${usage?.cost_usd ?? "?"}`);
      break;
    }

    // Budget exhausted with tool results but no answer: one final call with no
    // tools available, forcing synthesis from what was gathered.
    if (depth >= maxDepth && !response) {
      logger.warn("[Agent] Max tool depth reached, forcing synthesis from gathered results.");
      const synthesis = await llm.chat({
        model: CONVO_MODEL,
        messages,
        temperature: 0.9,
        timeoutMs: 120_000,
        label: "agent-synthesis",
        variant: options.variant || "default",
      });
      response = synthesis.result.content?.trim()
        || synthesis.result.reasoning_content?.trim()
        || `I gathered some information (${toolResults.map(r => r.tool).join(", ")}) but wasn't able to complete the lookup. Let me know if you'd like me to try a different approach.`;
    }

    response = applyGuards(response, {
      toolResults,
      userText: input.text,
      hasAttachments: ctx.attachments.length > 0,
    });

    if (response) {
      response = applyCitations(response, citationStore, options.citationFormatters);
      response = stripUnresolvedCitations(response);
    }

    // Last resort. Silence is the one outcome worse than an imperfect reply.
    if (!response && ctx.attachments.length === 0) {
      logger.warn("[Guard] Turn produced no content; using fallback reply.");
      response = "Sorry — I wasn't able to put together a response to that. Could you rephrase?";
    }

    // Critique runs after the reply is returned, not before. Blocking every
    // reply on a second model call to catch an uncommon failure is the wrong
    // trade; hosts that can edit a sent message apply the revision via callback.
    if (response && !LOW_BUDGET_MODE && options.onRevision && critique.shouldCritique(response)) {
      const sentResponse = response;
      (async () => {
        try {
          const verdict = await critique.runCritique(messages, sentResponse);
          if (verdict.ok || !verdict.fix) return;
          logger.warn(`[Critique] Reply needs revision: ${verdict.fix.slice(0, 200)}`);
          const revised = await critique.reviseResponse(messages, sentResponse, verdict.fix, CONVO_MODEL);
          if (revised) await options.onRevision(revised, sentResponse);
        } catch (err) {
          logger.warn(`[Critique] Background revision failed, keeping original: ${err.message}`);
        }
      })();
    }

    // Memory accumulation runs in the background so the caller is never blocked.
    if (options.updateMemory !== false) {
      const turnMessages = [
        ...(options.history || []),
        { userId: input.userId, userName: input.userName, text: input.text,
          messageId: input.messageId, timestamp: input.timestamp || Date.now(), isAgent: false },
      ];
      summaries.tick(input.conversationId, turnMessages, input.userId, { onTopicChange: options.onTopicChange })
        .catch(err => logger.error(`[MemoryTick] Background tick failed: ${err.message}`));

      if (IMMEDIATE_FACTS_ENABLED) {
        facts.extractImmediateUserFacts({
          text: input.text,
          userId: input.userId,
          userName: input.userName,
          conversationId: input.conversationId,
          participants: participantsMap,
        }).catch(err => logger.error(`[Facts] immediate user: ${err.message}`));

        facts.extractImmediateContextFacts({
          text: input.text,
          userId: input.userId,
          conversationId: input.conversationId,
        }).catch(err => logger.error(`[Facts] immediate context: ${err.message}`));
      }
    }

    return {
      text: response,
      attachments: ctx.attachments,
      toolCalls: toolResults,
      usage,
      streamed,
    };
  } catch (err) {
    logger.error(`[Agent] Turn failed: ${err.message}`);
    return {
      text: null,
      attachments: ctx.attachments,
      toolCalls: toolResults,
      usage,
      streamed,
      error: err.message,
    };
  }
}

let _defaultRegistry = null;
function defaultRegistry() {
  if (!_defaultRegistry) {
    _defaultRegistry = new ToolRegistry().registerAll(BUILTIN_TOOLS);
  }
  return _defaultRegistry;
}

module.exports = {
  run,
  defaultRegistry,
  accumulateToolCalls,
  parseInlineToolCalls,
  presentMemberIds,
  trimToTokenBudget,
  applyGuards,
};
