// Structured-output validation. Every schema is compiled once at first use and
// cached, so validation costs a function call rather than a recompile.
//
// Two entry points with deliberately different failure modes:
//   - chatWithSchema(): model output. Retries once with the validation error fed
//     back as a correction, then gives up and returns `validated: null` so the
//     caller can fall back rather than throw.
//   - validateToolArgs(): model-authored tool arguments. Never throws — returns
//     a structured failure the agent loop hands back to the model, letting the
//     ReAct loop self-correct on the next iteration.

const Ajv = require("ajv");
const logger = require("../util/logger");
const llm = require("../llm");

// Strict mode catches malformed schemas (typo'd `type`, unknown keywords) at
// compile time instead of silently passing everything through validation.
const ajv = new Ajv({ strict: true });

const _validators = new Map();

function loadSchema(name) {
  if (_validators.has(name)) return _validators.get(name);
  const schema = require(`./json/${name}.json`);
  const validate = ajv.compile(schema);
  _validators.set(name, validate);
  return validate;
}

// Models routinely return prose-wrapped JSON ("Sure, here is the JSON:
// ```json\n{...}\n```\nLet me know if…"). Strip the fence if the whole reply is
// fenced; otherwise extract the first fenced block; otherwise carve out the
// first balanced object/array span. Falls back to the trimmed string so the
// JSON.parse error path still triggers on genuinely malformed input.
function cleanMarkdownCode(raw) {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const firstObj = trimmed.indexOf("{");
  const firstArr = trimmed.indexOf("[");
  let start = -1;
  let open = "";
  let close = "";
  if (firstObj !== -1 && (firstArr === -1 || firstObj < firstArr)) {
    start = firstObj; open = "{"; close = "}";
  } else if (firstArr !== -1) {
    start = firstArr; open = "["; close = "]";
  }
  if (start === -1) return trimmed;
  // Walk forward tracking depth and string state, so braces inside string
  // literals do not throw off the balance count.
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inStr) {
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === "\"") inStr = false;
      continue;
    }
    if (ch === "\"") { inStr = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return trimmed.slice(start, i + 1);
    }
  }
  return trimmed.slice(start);
}

function parseAndValidate(schemaName, rawString) {
  const validate = loadSchema(schemaName);
  const cleaned = cleanMarkdownCode(rawString);
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    return { data: null, error: `JSON parse error: ${err.message}`, raw: cleaned };
  }
  if (!validate(parsed)) {
    const errors = validate.errors.map(e => `${e.instancePath || "root"}: ${e.message}`).join("; ");
    return { data: null, error: `Schema validation failed: ${errors}`, raw: cleaned };
  }
  return { data: parsed, error: null, raw: cleaned };
}

// Wraps llm.chat() with response_format + schema validation + one retry that
// feeds the validation error back to the model as a correction turn.
async function chatWithSchema(args) {
  const { schemaName, ...llmArgs } = args;
  loadSchema(schemaName); // fail fast on an unknown schema name

  const runChat = (extraMessages = []) => llm.chat({
    ...llmArgs,
    response_format: { type: "json_object" },
    messages: [...(llmArgs.messages || []), ...extraMessages],
  });

  const firstRes = await runChat();
  const firstParsed = parseAndValidate(schemaName, firstRes.result.content?.trim() || "");
  if (!firstParsed.error) {
    return { ...firstRes, validated: firstParsed.data };
  }

  logger.warn(`[Schema] First attempt failed for "${schemaName}": ${firstParsed.error}. Retrying once.`);
  const retryRes = await runChat([
    { role: "user", content: `Your previous response violated the schema: ${firstParsed.error}. Please fix it and respond with valid JSON only.` },
  ]);
  const retryRaw = retryRes.result.content?.trim() || "";
  const retryParsed = parseAndValidate(schemaName, retryRaw);
  if (!retryParsed.error) {
    return { ...retryRes, validated: retryParsed.data };
  }

  logger.warn(`[Schema] Retry also failed for "${schemaName}": ${retryParsed.error}`);
  return { ...retryRes, validated: null, schemaError: retryParsed.error, raw: retryRaw };
}

// Validates tool-call arguments against json/tools/<toolName>.json.
// Returns { valid: true } on pass, or when no schema is registered for the tool.
// Returns { valid: false, errors } on violation — the caller returns that to the
// model as a tool result rather than throwing, so the loop can self-correct.
function validateToolArgs(toolName, args) {
  let validate;
  try {
    validate = loadSchema(`tools/${toolName}`);
  } catch (err) {
    if (err.code === "MODULE_NOT_FOUND") return { valid: true };
    throw err;
  }
  if (validate(args)) return { valid: true };
  const errors = validate.errors.map(e => `${e.instancePath || "root"}: ${e.message}`).join("; ");
  return { valid: false, errors };
}

module.exports = { parseAndValidate, chatWithSchema, validateToolArgs, cleanMarkdownCode };
