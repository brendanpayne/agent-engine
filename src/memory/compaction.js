// Archive -> episode compaction. The oldest tier of the memory hierarchy.
//
// When a conversation's archive grows past ARCHIVE_COMPACTION_THRESHOLD, the
// oldest SUMMARY_INTERVAL chunks are compressed into a single episode and
// deleted. Raw messages become one retrievable event, and the oldest rolling
// summary is pruned in step so the two tiers describe disjoint time ranges
// rather than the same period twice.
//
// This is what bounds storage growth without losing the past outright: recent
// history stays searchable verbatim, older history survives as episodes.

const {
  CONVO_MODEL,
  SUMMARY_INTERVAL,
  ARCHIVE_COMPACTION_THRESHOLD,
  ARCHIVE_RETENTION_DAYS,
  ARCHIVE_MAX_ROWS_PER_CHANNEL,
} = require("../../config.js");
const logger = require("../util/logger");
const { chatWithSchema } = require("../schemas");
const archive = require("../archive");
const episodes = require("../episodes");
const jobs = require("../jobs");
const store = require("./store");

const CHUNK_MAX_CHARS = 300;

function formatChunksForPrompt(chunks) {
  return chunks.map(c => {
    const ts = new Date(c.created_at).toISOString().slice(0, 16).replace("T", " ");
    const text = c.content.length > CHUNK_MAX_CHARS ? c.content.slice(0, CHUNK_MAX_CHARS) + "…" : c.content;
    return `[${ts}] user_${c.author_id}: ${text}`;
  }).join("\n");
}

// Compact one window for a single conversation. Returns a result object, or
// null when the conversation is below threshold or has nothing to compact.
async function compactConversation(conversationId) {
  const count = archive.countForConversation(conversationId);
  if (count <= ARCHIVE_COMPACTION_THRESHOLD) {
    logger.debug(`[Compaction] ${conversationId}: ${count} chunks <= threshold ${ARCHIVE_COMPACTION_THRESHOLD}, skipping`);
    return null;
  }

  const chunks = archive.getOldestChunks(conversationId, SUMMARY_INTERVAL);
  if (chunks.length === 0) return null;

  logger.info(`[Compaction] ${conversationId}: compacting ${chunks.length} chunks (archive has ${count})`);

  const res = await chatWithSchema({
    schemaName: "episode-compaction",
    model: CONVO_MODEL,
    messages: [
      { role: "system", content: "You compress conversation history into structured episode memory. Output only JSON." },
      { role: "user", content: [
        "Compress the following conversation excerpt into ONE episode entry.",
        "An episode records a specific event or milestone that occurred, not general facts.",
        "Rules:",
        "- summary: 1-2 sentences, past tense, concrete (who, what happened, outcome). Max 250 characters.",
        "- tags: 2-5 short lowercase keywords that help retrieve this episode later.",
        "Respond with ONLY valid JSON: {\"summary\": \"...\", \"tags\": [\"...\"]}",
        "",
        "[Excerpt]",
        formatChunksForPrompt(chunks),
      ].join("\n") },
    ],
    max_tokens: 256,
    temperature: 0.2,
    timeoutMs: 30_000,
    label: "compactEpisode",
    variant: "compaction",
  });

  const summary = res.validated?.summary?.trim();
  // Without a summary the chunks must NOT be deleted — losing them with nothing
  // written in their place is unrecoverable. Bail and retry next pass.
  if (!summary) throw new Error(`Compaction produced no valid summary: ${res.schemaError || "empty"}`);
  const tags = Array.isArray(res.validated.tags) ? res.validated.tags.filter(t => typeof t === "string") : [];

  const episodeId = episodes.addEpisode({
    scopeType: "conversation",
    scopeId: conversationId,
    summary,
    tags,
    source: "compaction",
  });

  jobs.enqueue({
    kind: "episode_embed",
    payload: { episodeIds: [episodeId] },
    run_at: Date.now(),
    priority: -1,
  });

  const deleted = archive.deleteChunks(chunks.map(c => c.id));
  logger.info(`[Compaction] ${conversationId}: episode ${episodeId} created, ${deleted} chunks removed`);

  // Drop the oldest rolling summary — the episode now covers that period.
  try {
    const ctx = store.getConversation(conversationId);
    if (Array.isArray(ctx.summaries) && ctx.summaries.length > 0) {
      await store.updateConversation(conversationId, { summaries: ctx.summaries.slice(1) });
      logger.debug(`[Compaction] ${conversationId}: pruned oldest summary`);
    }
  } catch (err) {
    // Non-fatal: the episode is already written.
    logger.warn(`[Compaction] ${conversationId}: summary prune failed: ${err.message}`);
  }

  return { episodeId, summary, chunksCompacted: chunks.length };
}

// Run one compaction pass across the given conversations, then apply archive
// retention. Per-conversation errors are contained so one bad conversation
// cannot stall the rest.
async function runCompactionPass(conversationIds = []) {
  logger.info(`[Compaction] Starting pass over ${conversationIds.length} conversation(s)`);
  let compacted = 0;
  let skipped = 0;
  let errors = 0;

  for (const conversationId of conversationIds) {
    try {
      const result = await compactConversation(conversationId);
      if (result) {
        compacted++;
        logger.info(`[Compaction] ${conversationId}: "${result.summary.slice(0, 80)}…"`);
      } else {
        skipped++;
      }
    } catch (err) {
      errors++;
      logger.error(`[Compaction] ${conversationId} failed: ${err.message}`);
    }
  }

  const pruned = archive.prune({
    retentionDays: ARCHIVE_RETENTION_DAYS,
    maxRowsPerConversation: ARCHIVE_MAX_ROWS_PER_CHANNEL,
  });

  logger.info(`[Compaction] Pass complete: ${compacted} compacted, ${skipped} skipped, ${errors} errors, pruned ${pruned.deletedByAge + pruned.deletedByCap} rows`);
  return { compacted, skipped, errors, pruned };
}

module.exports = { compactConversation, runCompactionPass };
