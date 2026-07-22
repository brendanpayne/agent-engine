// Token counting and cost estimation.
//
// The prompt-cache hit/miss split is a provider billing artifact: cached prefix
// tokens bill at a fraction of fresh ones, so a naive prompt_tokens * rate
// calculation overstates spend by an order of magnitude on cache-friendly
// workloads. Rates below are per 1M tokens and configurable via env.

const RATE_CACHE_HIT = Number(process.env.LLM_RATE_CACHE_HIT ?? 0.028);
const RATE_CACHE_MISS = Number(process.env.LLM_RATE_CACHE_MISS ?? 0.28);
const RATE_OUTPUT = Number(process.env.LLM_RATE_OUTPUT ?? 0.42);

function estimateTokenCount(text) {
  if (!text) return 0;
  // CJK characters tokenize at ~1 char/token
  const cjk = (text.match(/[一-龥぀-ヿ가-힯]/g) ?? []).length;
  // Numbers are isolated into groups of 1-3 digits by most BPE pre-tokenizers
  const digits = (text.match(/\p{N}{1,3}/gu) ?? []).length;
  // Remaining text (latin, punctuation, spaces) averages ~3.5 chars/token
  const remaining = text.length - cjk - (text.match(/\p{N}/gu) ?? []).length;
  return Math.ceil(cjk + digits + remaining / 3.5);
}

function estimateCost(apiResponse) {
  const usage = apiResponse?.usage || {};
  const hit = usage.prompt_cache_hit_tokens || 0;
  const miss = usage.prompt_cache_miss_tokens || 0;
  const completion = usage.completion_tokens || 0;
  // When the provider reports no cache split, treat all prompt tokens as a miss
  // so the estimate errs high rather than silently reporting zero.
  const effectiveMiss = (hit === 0 && miss === 0) ? (usage.prompt_tokens || 0) : miss;
  const cost = (hit * RATE_CACHE_HIT + effectiveMiss * RATE_CACHE_MISS + completion * RATE_OUTPUT) / 1_000_000;
  return cost.toFixed(6);
}

module.exports = { estimateTokenCount, estimateCost };
