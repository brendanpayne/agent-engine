// Image generation.
//
// The generated image is pushed onto ctx.attachments rather than returned in
// the tool result — a base64 payload in the tool message would be re-sent to
// the model on every subsequent loop iteration. The model gets a short
// acknowledgement; the host reads ctx.attachments off the final result.

const logger = require("../../../util/logger");
const llm = require("../../../llm");
const { canGenerateImage } = require("../../../util/ratelimiter");

const generateImage = {
  name: "generate_image",
  description:
    "Generate a brand-new image from a text prompt and attach it to your reply. " +
    "CALL THIS whenever the user asks you to make, create, generate, draw, paint, render, or design an " +
    "image/picture/drawing/artwork/poster. " +
    "IMPORTANT: You CANNOT produce images yourself — you MUST use this tool. Never claim you generated or " +
    "attached an image without calling it, and never type attachment placeholder text instead of calling it. " +
    "Do NOT call for: metaphorical 'imagine this', discussing existing images, or reacting to an image the user shared.",
  sideEffect: true,
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "The user's request rewritten as a detailed visual description: subject, style, setting, composition, mood.",
      },
    },
    required: ["prompt"],
  },
  async handler(args, ctx) {
    const userId = ctx.input?.userId;
    if (userId) {
      const rateCheck = canGenerateImage(userId);
      if (!rateCheck.allowed) return { error: rateCheck.reason, retry_at: rateCheck.retryAt };
    }

    try {
      const { buffer, mimeType } = await llm.generateImage({ prompt: args.prompt });
      const ext = mimeType?.includes("png") ? "png" : "jpg";
      ctx.attachments.push({ buffer, mimeType, filename: `generated.${ext}` });
      return {
        success: true,
        message: "Image generated. It is attached to your reply automatically. Reply naturally — do not describe the image or include any attachment markup.",
      };
    } catch (err) {
      logger.error(`[generate_image] ${err.message}`);
      return { error: `Image generation failed: ${err.message}` };
    }
  },
};

module.exports = { generateImage };
