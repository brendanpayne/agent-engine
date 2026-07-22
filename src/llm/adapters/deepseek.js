// Chat completions over an OpenAI-compatible endpoint. Defaults to DeepSeek;
// point LLM_BASE_URL at any compatible server (a local vLLM/Ollama gateway,
// OpenAI itself, OpenRouter) and the rest of the engine is unaffected.
//
// This module owns the single chat client — no other file constructs one. The
// adapter is retry- and timeout-naive; the router wraps it.

const { OpenAIApi, Configuration } = require("openai");
const config = require("../../../config.js");
const logger = require("../../util/logger");

let _client = null;
let _clientKey = null;
let _clientBase = null;

function getClient() {
  const key = process.env.LLM_API_KEY;
  if (!key) throw new Error("LLM_API_KEY is not set.");
  const basePath = config.LLM_BASE_URL;
  // Re-create on key or endpoint change so a rotated credential takes effect
  // without a restart.
  if (_client && _clientKey === key && _clientBase === basePath) return _client;

  logger.debug(`[chat] Using endpoint ${basePath}`);
  _client = new OpenAIApi(new Configuration({ apiKey: key, basePath }));
  _clientKey = key;
  _clientBase = basePath;
  return _client;
}

function buildPayload(args, extra = {}) {
  const payload = { model: args.model, messages: args.messages || [], ...extra };
  if (args.temperature !== undefined) payload.temperature = args.temperature;
  if (args.max_tokens !== undefined) payload.max_tokens = args.max_tokens;
  if (args.tools !== undefined) payload.tools = args.tools;
  if (args.tool_choice !== undefined) payload.tool_choice = args.tool_choice;
  if (args.response_format !== undefined) payload.response_format = args.response_format;
  return payload;
}

async function chat(args) {
  const client = getClient();
  const raw = await client.createChatCompletion(buildPayload(args));
  const choice = raw?.data?.choices?.[0];
  const message = choice?.message || {};
  return {
    result: {
      content: message.content ?? "",
      reasoning_content: message.reasoning_content,
      tool_calls: message.tool_calls,
      finish_reason: choice?.finish_reason,
    },
    usage: raw?.data?.usage || {},
    raw,
  };
}

function parseSSELine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data: ")) return null;
  const data = trimmed.slice(6).trim();
  if (data === "[DONE]") return "DONE";
  try {
    const parsed = JSON.parse(data);
    const delta = parsed.choices?.[0]?.delta;
    return {
      content: delta?.content || "",
      reasoning_content: delta?.reasoning_content || "",
      tool_calls: delta?.tool_calls,
      finish_reason: parsed.choices?.[0]?.finish_reason,
    };
  } catch (_) {
    // Malformed SSE frames are dropped rather than aborting the stream.
    return null;
  }
}

async function* chatStream(args) {
  const client = getClient();
  const raw = await client.createChatCompletion(buildPayload(args, { stream: true }), { responseType: "stream" });

  let buffer = "";
  for await (const chunk of raw.data) {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep the incomplete trailing line
    for (const line of lines) {
      const parsed = parseSSELine(line);
      if (parsed === "DONE") return;
      if (parsed) yield parsed;
    }
  }

  const tail = parseSSELine(buffer);
  if (tail && tail !== "DONE") yield tail;
}

module.exports = { chat, chatStream, getClient };
