// Knowledge-base tools: read curated entries, propose new ones.
//
// Reading is unrestricted; writing is not. propose_kb_entry queues an entry for
// human review rather than writing it — an agent that can silently edit its own
// source of truth will eventually launder a hallucination into it.

const logger = require("../../../util/logger");
const llm = require("../../../llm");
const kb = require("../../../kb");

const lookupKb = {
  name: "lookup_kb",
  description:
    "Search the curated knowledge base for entries related to a topic. Returns up to 3 relevant entries. " +
    "Use this whenever the user asks about documented policies, FAQs, reference material, or stored institutional knowledge. " +
    "Do not guess — search the knowledge base first.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "The topic or question to look up." },
    },
    required: ["query"],
  },
  async handler(args, ctx) {
    const scopeId = ctx.input?.scopeId;
    if (!scopeId) return { error: "No knowledge base scope is configured for this conversation." };
    try {
      const { embedding } = await llm.embed({ text: args.query });
      const results = kb.search(scopeId, embedding, 3);
      if (results.length === 0) {
        return { results: [], message: "No matching knowledge base entries found." };
      }
      return {
        results: results.map((r, i) => ({
          result_index: i + 1,
          slug: r.slug,
          title: r.title,
          content: r.content.length > 500 ? r.content.slice(0, 500) + "..." : r.content,
        })),
      };
    } catch (err) {
      logger.error(`[lookup_kb] ${err.message}`);
      return { error: `Knowledge base lookup failed: ${err.message}` };
    }
  },
};

const proposeKbEntry = {
  name: "propose_kb_entry",
  description:
    "Propose a new knowledge-base entry for human review. Use when the conversation establishes durable, " +
    "generally useful reference information that is not already in the knowledge base. " +
    "The entry does NOT go live until a human approves it — say it was proposed, never that it was added.",
  sideEffect: true,
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "A short descriptive title (2-100 characters)." },
      body: { type: "string", description: "The entry content (2-4000 characters)." },
      tags: { type: "array", items: { type: "string" }, description: "Optional keywords for retrieval." },
    },
    required: ["title", "body"],
  },
  async handler(args, ctx) {
    const scopeId = ctx.input?.scopeId;
    if (!scopeId) return { error: "No knowledge base scope is configured for this conversation." };

    const title = (args.title || "").trim();
    const body = (args.body || "").trim();
    if (title.length < 2 || title.length > 100) return { error: "Title must be 2-100 characters." };
    if (body.length < 2 || body.length > 4000) return { error: "Body must be 2-4000 characters." };

    const tags = Array.isArray(args.tags) && args.tags.length
      ? args.tags.map(t => String(t).trim()).filter(Boolean).join(", ").slice(0, 200) || null
      : null;

    try {
      const proposal = kb.proposals.propose({
        scopeId,
        title,
        content: body,
        tags,
        source: "agent",
        originUserId: ctx.input?.userId || null,
      });
      if (!proposal) {
        return { note: "A matching entry is already pending review — no need to propose it again." };
      }

      // The host decides how a reviewer is notified. If notification fails the
      // proposal is stranded: nobody will ever see it, and its dedup hash would
      // block a retry. Drop it and tell the model the truth.
      if (typeof ctx.onProposal === "function") {
        const delivered = await ctx.onProposal(proposal).catch(err => {
          logger.warn(`[propose_kb_entry] Reviewer notification threw: ${err.message}`);
          return false;
        });
        if (delivered === false) {
          kb.proposals.remove(proposal.id);
          return { error: "Could not deliver the proposal for review. It was not saved." };
        }
      }

      return {
        success: true,
        message: `Proposed "${title}" to the knowledge base. It is pending human approval before it goes live.`,
        proposal_id: proposal.id,
      };
    } catch (err) {
      logger.error(`[propose_kb_entry] ${err.message}`);
      return { error: `Could not submit the proposal: ${err.message}` };
    }
  },
};

module.exports = { lookupKb, proposeKbEntry };
