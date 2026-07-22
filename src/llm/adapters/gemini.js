// Google Gemini adapter — vision (image -> text). Image generation lives in
// adapters/cloudflare.js, since Gemini image-gen requires billing to be enabled
// and the Workers AI path works on a free tier.

const { GoogleGenAI } = require("@google/genai");
const logger = require("../../util/logger");
const { isSafeUrl } = require("../../util/ssrf");

const VISION_MODEL = process.env.VISION_MODEL || "gemini-2.5-flash";

let _client = null;
function getClient() {
  if (_client) return _client;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    logger.warn("GEMINI_API_KEY is not set — vision features will be unavailable.");
    return null;
  }
  _client = new GoogleGenAI({ apiKey });
  return _client;
}

async function describeImage({ imageUrl, userHint = null }) {
  const ai = getClient();
  if (!ai) return { error: "Vision is unavailable (GEMINI_API_KEY not configured)." };

  const urlCheck = isSafeUrl(imageUrl);
  if (!urlCheck.safe) {
    logger.warn(`[vision] Blocked unsafe image URL: ${imageUrl} (${urlCheck.reason})`);
    return { error: `Image URL is not allowed: ${urlCheck.reason}` };
  }
  const res = await fetch(imageUrl);
  // A safe first hop can still redirect somewhere internal — re-check.
  if (res.url && res.url !== imageUrl) {
    const redirectCheck = isSafeUrl(res.url);
    if (!redirectCheck.safe) {
      logger.warn(`[vision] Blocked redirect to unsafe URL: ${res.url} (${redirectCheck.reason})`);
      return { error: `Redirect target is not allowed: ${redirectCheck.reason}` };
    }
  }
  if (!res.ok) {
    logger.warn(`[vision] Failed to fetch image (${res.status}): ${imageUrl}`);
    return { error: `Could not download the image (HTTP ${res.status}).` };
  }
  const mimeType = res.headers.get("content-type")?.split(";")[0] || "image/jpeg";
  const base64 = Buffer.from(await res.arrayBuffer()).toString("base64");

  const promptText = userHint
    ? `A user has shared an image and asked: "${userHint}". Answer their question directly using the image as your source, and include any relevant context from the image that supports your answer.`
    : "Describe this image in 2-4 sentences. Note subjects, setting, mood, text, and anything unusual.";

  const raw = await ai.models.generateContent({
    model: VISION_MODEL,
    contents: [{
      role: "user",
      parts: [
        { text: promptText },
        { inlineData: { mimeType, data: base64 } },
      ],
    }],
  });

  const text =
    raw?.text ??
    raw?.candidates?.[0]?.content?.parts?.find(p => p.text)?.text ??
    null;
  if (!text) {
    logger.warn("[vision] describeImage returned no text.");
    return { error: "Vision model returned no description (possibly blocked or filtered)." };
  }
  return { description: text.trim(), raw };
}

module.exports = { describeImage, getClient };
