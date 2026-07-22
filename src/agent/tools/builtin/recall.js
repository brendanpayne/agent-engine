// Retrieval over the engine's own memory: verbatim history and episodes.
//
// Both use the same hybrid strategy — FTS first, embeddings only to re-rank
// what FTS found, full semantic scan only when FTS found nothing. Keyword
// search is effectively free and catches most queries; embeddings are reserved
// for the paraphrase cases that actually need them.

const { EPISODE_RECALL_MIN_SCORE } = require("../../../../config.js");
const logger = require("../../../util/logger");
const llm = require("../../../llm");
const archive = require("../../../archive");
const episodes = require("../../../episodes");

// SQLite FTS5 bm25 `rank` is negative and more negative means a better match.
// A top hit above this floor (i.e. close to zero) is weak enough to be worth
// re-ranking with embeddings.
const FTS_WEAK_RANK_THRESHOLD = -1.0;

// Strip filler before handing a natural-language question to FTS. A raw
// question is mostly stopwords, and FTS5's implicit AND would match nothing;
// OR-ing the content words gets recall, and semantic re-ranking fixes ordering.
const FTS_STOPWORDS = new Set([
  "the", "a", "an", "is", "was", "were", "are", "be", "been", "i", "you", "he", "she",
  "they", "we", "it", "that", "this", "what", "did", "do", "does", "how", "when",
  "where", "why", "who", "not", "no", "but", "and", "or", "if", "then", "so", "my",
  "your", "his", "her", "their", "our", "its", "at", "in", "on", "for", "of", "to",
  "with", "by", "from", "about", "said", "say", "says", "have", "has", "had",
  "would", "could", "should", "will", "can", "may", "might", "let", "get", "got",
  "make", "made", "know", "think", "want", "just", "like", "went", "come", "came",
  "go", "see", "saw", "tell", "told", "ask", "asked", "very", "really", "thing",
]);

function buildFTSQuery(rawQuery) {
  // FTS5 treats these as operators; a stray quote is a syntax error.
  const cleaned = rawQuery.replace(/["'()*^]/g, " ");
  const tokens = cleaned.toLowerCase().split(/\s+/)
    .filter(t => t.length > 2 && !FTS_STOPWORDS.has(t));
  if (tokens.length === 0) return cleaned.trim() || rawQuery;
  return tokens.join(" OR ");
}

async function embedQuery(query, label) {
  try {
    const { embedding } = await llm.embed({ text: query });
    return embedding;
  } catch (err) {
    logger.warn(`[${label}] Embedding failed, keyword results only: ${err.message}`);
    return null;
  }
}

const searchHistory = {
  name: "search_history",
  description:
    "Search this conversation's past message history. " +
    "Call AT MOST ONCE per turn with a single comprehensive query covering everything you want to find. " +
    "If results are empty or thin, answer from what is returned — do NOT retry with rephrasings.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "A single comprehensive query covering everything you want to find." },
      limit: { type: "integer", description: "Number of results to return (default 5, max 10)." },
    },
    required: ["query"],
  },
  async handler(args, ctx) {
    const limit = Math.min(Math.max(args.limit || 5, 1), 10);
    const conversationId = ctx.input?.conversationId;
    if (!conversationId) return { error: "No conversation context available." };

    const format = (r, i) => ({
      result_index: i + 1,
      message_id: r.message_id,
      author_id: r.author_id,
      content: r.content.length > 300 ? r.content.slice(0, 300) + "..." : r.content,
      timestamp: r.created_at ? new Date(r.created_at).toISOString() : "unknown",
    });

    try {
      const ftsResults = archive.searchFTS(conversationId, buildFTSQuery(args.query), 30);

      if (ftsResults.length === 0) {
        const embedding = await embedQuery(args.query, "search_history");
        if (embedding) {
          const semantic = archive.searchSemanticFull(conversationId, embedding, limit);
          if (semantic.length > 0) {
            return {
              results: semantic.map(format),
              total_matches: semantic.length,
              note: "Results via semantic search (no keyword matches).",
            };
          }
        }
        return {
          results: [],
          total_matches: 0,
          // Without this the model reliably burns the remaining tool budget on
          // synonym retries of a query that has no matches.
          note: "No matches in this conversation's history. Do not retry with paraphrases — answer from prior context or state that you have no record.",
        };
      }

      let finalResults = ftsResults.slice(0, limit);
      const topRank = ftsResults[0]?.rank;
      const needsSemantic =
        (typeof topRank === "number" && topRank > FTS_WEAK_RANK_THRESHOLD) ||
        ftsResults.length < limit;

      if (needsSemantic) {
        const embedding = await embedQuery(args.query, "search_history");
        if (embedding) {
          const reranked = archive.searchSemantic(conversationId, embedding, ftsResults.map(r => r.id), limit);
          if (reranked.length > 0) finalResults = reranked;
        }
      }

      const out = { results: finalResults.map(format), total_matches: ftsResults.length };
      if (finalResults.length < limit) {
        out.note = "These are all matches for this query. Do not re-query with variations — synthesize from these results.";
      }
      return out;
    } catch (err) {
      logger.error(`[search_history] ${err.message}`);
      return { error: `History search failed: ${err.message}` };
    }
  },
};

const recallEpisode = {
  name: "recall_episode",
  description:
    "Retrieve specific past events from episodic memory — things that happened on a particular occasion, " +
    "as opposed to stable facts. Use when the user references a past event, asks what happened on a specific " +
    "occasion, or when stored facts are not enough. " +
    "Scope 'conversation' searches shared events, 'user' searches the speaker's own episodes, 'both' searches both.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "What past event to look for." },
      scope: { type: "string", enum: ["conversation", "user", "both"], description: "Which episode scope to search (default: both)." },
      limit: { type: "integer", description: "Number of results to return (default 5, max 10)." },
    },
    required: ["query"],
  },
  async handler(args, ctx) {
    const scope = args.scope || "both";
    const limit = Math.min(Math.max(args.limit || 5, 1), 10);

    const scopePairs = [];
    if ((scope === "conversation" || scope === "both") && ctx.input?.conversationId) {
      scopePairs.push({ scopeType: "conversation", scopeId: ctx.input.conversationId });
    }
    if ((scope === "user" || scope === "both") && ctx.input?.userId) {
      scopePairs.push({ scopeType: "user", scopeId: ctx.input.userId });
    }
    if (scopePairs.length === 0) return { error: "No episode scope available for this request." };

    const format = (r, i) => ({
      result_index: i + 1,
      scope: r.scope_type,
      summary: r.summary,
      tags: r.tags ? JSON.parse(r.tags) : [],
      source: r.source,
      occurred_at: new Date(r.created_at).toISOString(),
    });

    try {
      const ftsResults = episodes.searchFTS(scopePairs, buildFTSQuery(args.query), 30);

      if (ftsResults.length === 0) {
        const embedding = await embedQuery(args.query, "recall_episode");
        if (embedding) {
          // A relevance floor is essential here: semantic search always returns
          // the *closest* episodes no matter how weak the match, so without it
          // an unrelated query confidently surfaces irrelevant events.
          const semantic = episodes.searchSemanticFull(scopePairs, embedding, limit)
            .filter(r => r.score >= EPISODE_RECALL_MIN_SCORE);
          if (semantic.length > 0) {
            return { results: semantic.map(format), note: "Results via semantic search (no keyword matches)." };
          }
        }
        return { results: [], note: "No episodes found for that query. Do not retry with paraphrases." };
      }

      let finalResults = ftsResults.slice(0, limit);
      const topRank = ftsResults[0]?.rank;
      const needsSemantic =
        (typeof topRank === "number" && topRank > FTS_WEAK_RANK_THRESHOLD) ||
        ftsResults.length < limit;

      if (needsSemantic) {
        const embedding = await embedQuery(args.query, "recall_episode");
        if (embedding) {
          const reranked = episodes.searchSemantic(embedding, ftsResults.map(r => r.id), limit);
          if (reranked.length > 0) finalResults = reranked;
        }
      }

      return { results: finalResults.map(format), total_matches: ftsResults.length };
    } catch (err) {
      logger.error(`[recall_episode] ${err.message}`);
      return { error: `Episode recall failed: ${err.message}` };
    }
  },
};

module.exports = { searchHistory, recallEpisode, buildFTSQuery };
