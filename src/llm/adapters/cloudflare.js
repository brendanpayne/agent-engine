// Cloudflare Workers AI adapter — text-to-image and text embeddings.
//
// Env-load ordering: whoever boots the process must load dotenv before any
// require chain reaches this file. A standalone script that requires the engine
// without loading env first will see empty credentials.

const config = require("../../../config.js");
const logger = require("../../util/logger");

const IMAGE_MODEL = process.env.IMAGE_MODEL || "black-forest-labs/flux-1-schnell";
const EMBED_MODEL = process.env.EMBED_MODEL || "baai/bge-base-en-v1.5";

function runUrl(model) {
  return `https://api.cloudflare.com/client/v4/accounts/${config.CF_ACCOUNT_ID}/ai/run/@cf/${model}`;
}

function requireCredentials() {
  if (!config.CF_ACCOUNT_ID || !config.CF_API_KEY) {
    logger.error("[CF] CF_ACCOUNT_ID or CF_API_KEY is not set.");
    throw new Error("CF_ACCOUNT_ID or CF_API_KEY is not set.");
  }
}

async function post(model, body) {
  requireCredentials();
  const url = runUrl(model);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.CF_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    logger.error(`[CF] ${model} non-OK response: ${JSON.stringify(err)}`);
    throw new Error(`Cloudflare ${model} call failed: ${JSON.stringify(err)}`);
  }
  return response.json();
}

async function generateImage({ prompt }) {
  logger.debug(`[CF] generateImage prompt="${prompt}"`);
  const body = await post(IMAGE_MODEL, { prompt });
  const image = body?.result?.image;
  if (!image || typeof image !== "string") {
    logger.error(`[CF] No base64 image in result. Body preview: ${JSON.stringify(body).slice(0, 500)}`);
    throw new Error("Cloudflare returned no image data.");
  }
  // JPEG base64 always begins with the SOI marker; anything else is PNG here.
  const mimeType = image.startsWith("/9j/") ? "image/jpeg" : "image/png";
  const buffer = Buffer.from(image, "base64");
  logger.debug(`[CF] decoded image buffer=${buffer.length} bytes mime=${mimeType}`);
  return { buffer, mimeType, text: null };
}

async function embedText({ text }) {
  logger.debug(`[CF] embedText text="${text.slice(0, 80)}…"`);
  const body = await post(EMBED_MODEL, { text });
  const embedding = body?.result?.data?.[0];
  if (!Array.isArray(embedding)) {
    logger.error(`[CF] No embedding in result. Body preview: ${JSON.stringify(body).slice(0, 500)}`);
    throw new Error("Cloudflare returned no embedding data.");
  }
  return { embedding: new Float32Array(embedding) };
}

module.exports = { generateImage, embedText };
