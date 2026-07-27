// Standing-directive tools: let the model record and retract durable
// behavioral rules for the conversation it is in.
//
// These write straight through rather than queueing for review (unlike
// propose_kb_entry) because a directive only constrains the agent's own
// behavior — the worst case is an over-cautious reply, not a laundered
// hallucination in a shared source of truth. Both are side-effecting, so the
// registry's read-only dedup cache must not swallow a repeat call.

const logger = require("../../../util/logger");
const { withLock } = require("../../../util/lock");
const memoryStore = require("../../../memory/store");
const { mergeDirectives, removeDirective } = require("../../../memory/directives");

const setDirective = {
  name: "set_directive",
  description:
    "Record a standing instruction for this conversation — a rule about your own behavior that must hold from now on, " +
    "such as 'never reveal the answer to word games, give hints only when asked'. " +
    "Call this the moment someone states a durable behavioral rule, even in passing, then confirm it briefly in your reply. " +
    "Standing instructions never expire and survive context resets. " +
    "Do NOT call for one-off requests, personal facts about a user, or anything scoped to the current message only.",
  sideEffect: true,
  parameters: {
    type: "object",
    properties: {
      instruction: {
        type: "string",
        description: "The rule as a short imperative sentence describing how you must behave.",
      },
    },
    required: ["instruction"],
  },
  async handler(args, ctx) {
    const instruction = (args?.instruction || "").trim();
    if (!instruction) return { error: "Missing required 'instruction' argument." };
    const conversationId = ctx.input?.conversationId;
    if (!conversationId) return { error: "No conversation context available." };

    try {
      return await withLock(`directives:${conversationId}`, async () => {
        const context = memoryStore.getConversation(conversationId);
        const existing = Array.isArray(context.directives) ? context.directives : [];
        const merged = mergeDirectives(existing, [instruction], {
          createdBy: ctx.input?.userId || null,
          source: "tool",
        });
        if (merged.added.length === 0 && merged.reinforced.length === 0) {
          return { success: false, message: "That instruction could not be stored." };
        }
        await memoryStore.updateConversation(conversationId, { directives: merged.directives });
        const entry = merged.added[0];
        logger.info(`[Directives] set_directive stored "${instruction}" in ${conversationId}`);
        return {
          success: true,
          directive_id: entry ? entry.id : merged.reinforced[0],
          already_known: merged.added.length === 0,
          total: merged.directives.length,
          message: merged.added.length === 0
            ? "That standing instruction was already recorded."
            : "Standing instruction recorded. It will persist until someone retracts it.",
        };
      });
    } catch (err) {
      logger.error(`[set_directive] ${err.message}`);
      return { error: `Could not store the instruction: ${err.message}` };
    }
  },
};

const removeDirectiveTool = {
  name: "remove_directive",
  description:
    "Cancel a standing instruction this conversation previously set, when someone explicitly retracts it " +
    "(\"you can talk about spoilers again\"). Pass the instruction's id from the [Standing Instructions] block, " +
    "or its wording if you do not have the id.",
  sideEffect: true,
  parameters: {
    type: "object",
    properties: {
      directive: { type: "string", description: "The directive id, or its text." },
    },
    required: ["directive"],
  },
  async handler(args, ctx) {
    const target = (args?.directive || "").trim();
    if (!target) return { error: "Missing required 'directive' argument." };
    const conversationId = ctx.input?.conversationId;
    if (!conversationId) return { error: "No conversation context available." };

    try {
      return await withLock(`directives:${conversationId}`, async () => {
        const context = memoryStore.getConversation(conversationId);
        const existing = Array.isArray(context.directives) ? context.directives : [];
        const { directives, removed } = removeDirective(existing, target);
        if (!removed) return { success: false, message: "No matching standing instruction found." };
        await memoryStore.updateConversation(conversationId, { directives });
        logger.info(`[Directives] remove_directive dropped "${removed.text}" from ${conversationId}`);
        return { success: true, removed: removed.text, remaining: directives.length };
      });
    } catch (err) {
      logger.error(`[remove_directive] ${err.message}`);
      return { error: `Could not remove the instruction: ${err.message}` };
    }
  },
};

module.exports = { setDirective, removeDirective: removeDirectiveTool };
