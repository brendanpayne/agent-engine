// Public surface for the provider layer. Everything that needs to invoke a
// model goes through this module — never an adapter directly — so retry,
// timeout, cost accounting, and cache stats stay uniform.

const router = require("./router");
const embedCache = require("./embedCache");
const { estimateCost, estimateTokenCount } = require("./cost");

module.exports = {
  chat: router.chat,
  chatStream: router.chatStream,
  describeImage: router.describeImage,
  generateImage: router.generateImage,
  embed: router.embed,
  getCacheStats: router.getCacheStats,
  closeEmbedCache: embedCache.close,
  estimateCost,
  estimateTokenCount,
};
