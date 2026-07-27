// Public API surface.
//
// Typical embedding:
//
//   require("dotenv").config();
//   const engine = require("agent-engine");
//   engine.jobs.registerDefaultHandlers(engine.jobs);
//   engine.jobs.start();
//
//   const result = await engine.run({
//     userId: "u_1", conversationId: "c_1", text: "hello",
//   });
//
// Register your own tools by building a registry and passing it per turn:
//
//   const registry = new engine.ToolRegistry()
//     .registerAll(engine.BUILTIN_TOOLS)
//     .register({ name: "deploy", description: "...", parameters: {...},
//                 handler: async (args, ctx) => ({ ok: true }) });
//   await engine.run(input, { registry });

const config = require("./config.js");
const agent = require("./src/agent");
const llm = require("./src/llm");
const memory = require("./src/memory");
const kb = require("./src/kb");
const archive = require("./src/archive");
const episodes = require("./src/episodes");
const jobs = require("./src/jobs");
const { registerDefaultHandlers } = require("./src/jobs/handlers");
const schemas = require("./src/schemas");
const logger = require("./src/util/logger");
const ratelimiter = require("./src/util/ratelimiter");
const { splitAtWordBoundary } = require("./src/util/textSplit");
const { isSafeUrl } = require("./src/util/ssrf");
const { extractFirstUrl, fetchPageText } = require("./src/util/urlContext");
const { withLock, withUserLock } = require("./src/util/lock");
const text = require("./src/util/text");

// Close every open database. Call on shutdown so WAL files checkpoint cleanly.
function close() {
  jobs.stop();
  memory.store.close();
  kb.preflight.invalidate();
  kb.close();
  kb.proposals.close();
  archive.close();
  episodes.close();
  llm.closeEmbedCache();
}

module.exports = {
  // Core
  run: agent.run,
  ToolRegistry: agent.ToolRegistry,
  BUILTIN_TOOLS: agent.BUILTIN_TOOLS,
  defaultRegistry: agent.defaultRegistry,

  // Subsystems
  agent,
  llm,
  memory,
  kb,
  archive,
  episodes,
  jobs: Object.assign({}, jobs, { registerDefaultHandlers }),
  schemas,

  // Utilities
  config,
  logger,
  ratelimiter,
  text,
  splitAtWordBoundary,
  isSafeUrl,
  extractFirstUrl,
  fetchPageText,
  withLock,
  withUserLock,

  close,
};
