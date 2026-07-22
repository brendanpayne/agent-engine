// Built-in job handlers. Register these at startup to get embedding backfill
// for free; the reminder handler is intentionally NOT included, because only
// the host knows how to deliver a message to a user.

const logger = require("../util/logger");
const llm = require("../llm");
const archive = require("../archive");
const episodes = require("../episodes");
const kb = require("../kb");

// Embed archived message chunks. Failures throw so the queue's backoff retries
// them — a transient embedding-provider outage should not permanently leave
// chunks unsearchable.
async function messageEmbed(payload) {
  const rows = archive.getByIds(payload.chunkIds || []);
  if (rows.length === 0) return;
  let embedded = 0;
  for (const row of rows) {
    const { embedding } = await llm.embed({ text: row.content });
    archive.setEmbedding(row.id, embedding);
    embedded++;
  }
  logger.debug(`[Jobs] message_embed: embedded ${embedded}/${rows.length} chunk(s)`);
}

async function episodeEmbed(payload) {
  const rows = episodes.getByIds(payload.episodeIds || []);
  if (rows.length === 0) return;
  for (const row of rows) {
    const { embedding } = await llm.embed({ text: row.summary });
    episodes.setEmbedding(row.id, embedding);
  }
  logger.debug(`[Jobs] episode_embed: embedded ${rows.length} episode(s)`);
}

// Backfill any knowledge-base entry whose embedding was cleared by an edit.
async function kbEmbed() {
  const rows = kb.getUnembedded(50);
  if (rows.length === 0) return;
  for (const row of rows) {
    const { embedding } = await llm.embed({ text: `${row.title}\n${row.content}` });
    kb.setEmbedding(row.scope_id, row.slug, embedding);
  }
  logger.debug(`[Jobs] kb_embed: embedded ${rows.length} entry/entries`);
}

function registerDefaultHandlers(queue) {
  queue.register("message_embed", messageEmbed);
  queue.register("episode_embed", episodeEmbed);
  queue.register("kb_embed", kbEmbed);
  return queue;
}

module.exports = { registerDefaultHandlers, messageEmbed, episodeEmbed, kbEmbed };
