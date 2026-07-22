// Tool registry and dispatcher.
//
// A tool is a plain object: { name, description, parameters, handler,
// sideEffect }. The handler receives (args, ctx) where ctx carries the
// normalized AgentInput plus the engine's stores. No platform object ever
// reaches a handler — that is what makes the tool layer portable.
//
// Two invariants worth keeping when adding tools:
//   - Argument validation NEVER throws. A schema violation is returned to the
//     model as a tool result so the ReAct loop can correct itself next
//     iteration; throwing would abort a turn the model could have recovered.
//   - Read-only tools are deduplicated within a turn. Models re-issue near
//     identical queries when a first result looks thin; without the cache that
//     burns the entire tool budget on one question.

const logger = require("../../util/logger");
const { validateToolArgs } = require("../../schemas");

class ToolRegistry {
  constructor() {
    this._tools = new Map();
  }

  register(tool) {
    if (!tool?.name || typeof tool.handler !== "function") {
      throw new Error("A tool requires a `name` and a `handler` function.");
    }
    if (this._tools.has(tool.name)) {
      logger.warn(`[Tools] Overwriting already-registered tool "${tool.name}".`);
    }
    this._tools.set(tool.name, {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.parameters || { type: "object", properties: {}, required: [] },
      handler: tool.handler,
      sideEffect: !!tool.sideEffect,
    });
    return this;
  }

  registerAll(tools) {
    for (const tool of tools) this.register(tool);
    return this;
  }

  unregister(name) {
    return this._tools.delete(name);
  }

  has(name) {
    return this._tools.has(name);
  }

  get(name) {
    return this._tools.get(name);
  }

  names() {
    return [...this._tools.keys()];
  }

  isSideEffect(name) {
    return !!this._tools.get(name)?.sideEffect;
  }

  // OpenAI-style function-calling definitions for the chat request.
  definitions() {
    return [...this._tools.values()].map(t => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  size() {
    return this._tools.size;
  }
}

// Canonicalize arguments for the dedup cache: sort keys, and for strings
// lowercase, strip punctuation, and sort the words. "who wrote the docs?" and
// "the docs — who wrote them" collapse to the same key, which is the point.
function normalizeArgs(args) {
  if (!args || typeof args !== "object") return JSON.stringify(args ?? null);
  const out = {};
  for (const key of Object.keys(args).sort()) {
    const v = args[key];
    out[key] = typeof v === "string"
      ? v.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean).sort().join(" ")
      : v;
  }
  return JSON.stringify(out);
}

// Execute one tool call. Never throws: every failure path returns an object the
// loop can hand back to the model as a tool result.
async function executeToolCall(registry, toolCall, ctx) {
  const name = toolCall.function.name;

  let args;
  try {
    args = JSON.parse(toolCall.function.arguments || "{}");
  } catch (err) {
    logger.warn(`[Tools] ${name} sent unparseable arguments: ${err.message}`);
    return { error: "invalid_arguments", details: `Arguments were not valid JSON: ${err.message}` };
  }

  logger.info(`[Tools] ${name}(${JSON.stringify(args)})`);

  const argCheck = validateToolArgs(name, args);
  if (!argCheck.valid) {
    logger.warn(`[Tools] ${name} invalid_arguments: ${argCheck.errors}`);
    return { error: "invalid_arguments", details: argCheck.errors };
  }

  const tool = registry.get(name);
  if (!tool) return { error: `Unknown tool: ${name}` };

  // Side-effecting tools are never cached — a second call is a second action.
  const cacheable = ctx?.queryCache && !tool.sideEffect;
  const cacheKey = cacheable ? `${name}:${normalizeArgs(args)}` : null;
  if (cacheable && ctx.queryCache.has(cacheKey)) {
    logger.info(`[Tools] Dedup hit ${cacheKey}`);
    const cached = { ...ctx.queryCache.get(cacheKey) };
    const note = "Duplicate query — synthesize from the prior tool result for this call.";
    cached.note = cached.note ? `${cached.note} ${note}` : note;
    return cached;
  }

  let result;
  try {
    result = await tool.handler(args, ctx);
  } catch (err) {
    logger.error(`[Tools] Error in ${name}: ${err.message}`);
    result = { error: err.message };
  }

  if (cacheable) ctx.queryCache.set(cacheKey, result);
  logger.debug(`[Tools] ${name} result: ${JSON.stringify(result).slice(0, 500)}`);
  return result;
}

module.exports = { ToolRegistry, executeToolCall, normalizeArgs };
