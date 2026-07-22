// Central configuration. Every value reads from an environment variable first
// and falls back to a sane default, so the engine runs with an empty .env for
// everything except provider credentials.
//
// Secrets belong in .env, never here. See .env.example for the full list.

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "true" || raw === "1";
}

const config = {
  // --- Provider credentials -------------------------------------------------
  // The chat adapter reads LLM_API_KEY directly at call time so a key rotated
  // in the environment takes effect without a restart.
  LLM_BASE_URL: process.env.LLM_BASE_URL || "https://api.deepseek.com",
  CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID || "",
  CF_API_KEY: process.env.CF_API_KEY || "",
  SEARCH_API_KEY: process.env.SEARCH_API_KEY || "",

  // --- Models ---------------------------------------------------------------
  CONVO_MODEL: process.env.CONVO_MODEL || "deepseek-chat",
  CRITIQUE_MODEL: process.env.CRITIQUE_MODEL || "deepseek-chat",

  // --- Router reliability ---------------------------------------------------
  LLM_DEFAULT_TIMEOUT_MS: num("LLM_DEFAULT_TIMEOUT_MS", 60000),
  LLM_MAX_RETRIES: num("LLM_MAX_RETRIES", 3),
  LLM_STREAM_IDLE_TIMEOUT_MS: num("LLM_STREAM_IDLE_TIMEOUT_MS", 30000),

  // --- Agent loop -----------------------------------------------------------
  MAX_TOOL_DEPTH: num("MAX_TOOL_DEPTH", 5),
  STREAMING_ENABLED: bool("STREAMING_ENABLED", true),
  // Halves the tool budget, caps facts-in-prompt, and skips the critique pass.
  // Intended for cost-constrained deployments.
  LOW_BUDGET_MODE: bool("LOW_BUDGET_MODE", false),

  // --- Context window -------------------------------------------------------
  PAST_MESSAGES: num("PAST_MESSAGES", 15),
  MAX_API_MESSAGES: num("MAX_API_MESSAGES", 30),
  CHAT_MAX_PROMPT_TOKENS: num("CHAT_MAX_PROMPT_TOKENS", 24000),

  // --- Tiered memory --------------------------------------------------------
  SUMMARY_INTERVAL: num("SUMMARY_INTERVAL", 25),
  FACTS_INTERVAL: num("FACTS_INTERVAL", 15),
  TOPIC_UPDATE_INTERVAL: num("TOPIC_UPDATE_INTERVAL", 40),
  MAX_FACTS: num("MAX_FACTS", 25),
  MAX_SUMMARIES: num("MAX_SUMMARIES", 3),
  MAX_FACTS_IN_PROMPT: num("MAX_FACTS_IN_PROMPT", 15),
  FACT_TTL_DAYS: num("FACT_TTL_DAYS", 90),
  FACT_CONFIDENCE_THRESHOLD: num("FACT_CONFIDENCE_THRESHOLD", 2),
  INCLUDE_CHANNEL_FACTS_IN_PROMPT: bool("INCLUDE_CHANNEL_FACTS_IN_PROMPT", true),
  INCLUDE_USER_FACTS_IN_PROMPT: bool("INCLUDE_USER_FACTS_IN_PROMPT", true),
  IMMEDIATE_FACTS_ENABLED: bool("IMMEDIATE_FACTS_ENABLED", true),
  IMMEDIATE_FACTS_MIN_LENGTH: num("IMMEDIATE_FACTS_MIN_LENGTH", 20),
  IMMEDIATE_FACTS_DEBOUNCE_MS: num("IMMEDIATE_FACTS_DEBOUNCE_MS", 30000),

  // --- Archive & episodes ---------------------------------------------------
  ARCHIVE_RETENTION_DAYS: num("ARCHIVE_RETENTION_DAYS", 90),
  ARCHIVE_MAX_ROWS_PER_CHANNEL: num("ARCHIVE_MAX_ROWS_PER_CHANNEL", 5000),
  ARCHIVE_COMPACTION_THRESHOLD: num("ARCHIVE_COMPACTION_THRESHOLD", 1000),
  EPISODE_RECALL_MIN_SCORE: num("EPISODE_RECALL_MIN_SCORE", 0.55),

  // --- Job queue ------------------------------------------------------------
  JOB_TICK_MS: num("JOB_TICK_MS", 2000),
  JOB_BATCH_SIZE: num("JOB_BATCH_SIZE", 5),
  REMINDER_MAX_ACTIVE_PER_USER: num("REMINDER_MAX_ACTIVE_PER_USER", 20),

  // --- Rate limits ----------------------------------------------------------
  IMAGE_GEN_LIMIT: num("IMAGE_GEN_LIMIT", 5),
  IMAGE_GEN_WINDOW: num("IMAGE_GEN_WINDOW", 900),
  TURN_INFLIGHT_TIMEOUT_MS: num("TURN_INFLIGHT_TIMEOUT_MS", 120000),
  TURN_BURST_LIMIT: num("TURN_BURST_LIMIT", 30),
  TURN_BURST_WINDOW_MS: num("TURN_BURST_WINDOW_MS", 900000),

  // --- Storage paths --------------------------------------------------------
  DB_DIR: process.env.DB_DIR || "db",
  MEMORY_DB_PATH: process.env.MEMORY_DB_PATH || "db/memory.sqlite",
  KB_DB_PATH: process.env.KB_DB_PATH || "db/kb.sqlite",
  ARCHIVE_DB_PATH: process.env.ARCHIVE_DB_PATH || "db/archive.sqlite",
  EPISODES_DB_PATH: process.env.EPISODES_DB_PATH || "db/episodes.sqlite",
  JOB_DB_PATH: process.env.JOB_DB_PATH || "db/jobs.sqlite",
  EMBED_CACHE_DB_PATH: process.env.EMBED_CACHE_DB_PATH || "db/embed_cache.sqlite",

  // --- Logging --------------------------------------------------------------
  DEBUG_LOGGING: bool("DEBUG_LOGGING", false),
  LOG_DIR: process.env.LOG_DIR || "logs",
  LOG_TO_FILE: bool("LOG_TO_FILE", true),
};

module.exports = config;
