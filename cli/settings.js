// Persisted CLI settings.
//
// Two kinds of knobs live here. Most are read per turn and take effect
// immediately — streaming, tool exposure, persona, history depth. A few map to
// engine configuration that `src/agent/loop.js` destructures at module load
// (the model, low-budget mode), so those are applied to `process.env` *before*
// the engine is required and are flagged `restart: true` in the UI. Lying about
// that would be worse than the restart: a `/set model` that silently does
// nothing is the kind of bug a user debugs for an hour.

const fs = require("fs");
const path = require("path");

const SETTINGS_PATH = path.resolve(
  process.cwd(),
  process.env.CLI_SETTINGS_PATH || "db/cli-settings.json",
);

// key -> definition. `env` names the engine variable a setting feeds; `restart`
// marks settings the engine only reads at startup.
const DEFINITIONS = {
  model: {
    type: "string", default: null, env: "CONVO_MODEL", restart: true,
    describe: "Chat model id (blank = engine default)",
  },
  lowBudget: {
    type: "bool", default: false, env: "LOW_BUDGET_MODE", restart: true,
    describe: "Halve the tool budget, cap facts, skip the critique pass",
  },
  stream: {
    type: "bool", default: true,
    describe: "Stream tokens as they arrive",
  },
  tools: {
    type: "bool", default: true,
    describe: "Expose the built-in tools to the model",
  },
  memory: {
    type: "bool", default: true,
    describe: "Write facts and summaries after each turn",
  },
  toolDepth: {
    type: "int", default: null,
    describe: "Max tool iterations per turn (blank = engine default)",
  },
  persona: {
    type: "string", default: null,
    describe: "System persona override (blank = engine default)",
  },
  historyDepth: {
    type: "int", default: 20,
    describe: "Past messages replayed into each turn",
  },
  userId: {
    type: "string", default: "cli-user",
    describe: "Speaker id memory is anchored on",
  },
  userName: {
    type: "string", default: "You",
    describe: "Display name sent with each turn",
  },
  scopeId: {
    type: "string", default: "cli",
    describe: "Knowledge-base partition",
  },
  showUsage: {
    type: "bool", default: true,
    describe: "Print token count and cost after each reply",
  },
  showTools: {
    type: "bool", default: true,
    describe: "Print which tools ran during a turn",
  },
};

function coerce(key, raw) {
  const def = DEFINITIONS[key];
  if (!def) throw new Error(`Unknown setting "${key}".`);

  const text = String(raw).trim();
  if (text === "" || text === "default" || text === "none") return def.default;

  if (def.type === "bool") {
    if (["true", "on", "yes", "1"].includes(text.toLowerCase())) return true;
    if (["false", "off", "no", "0"].includes(text.toLowerCase())) return false;
    throw new Error(`"${key}" expects on/off, got "${text}".`);
  }
  if (def.type === "int") {
    const parsed = Number(text);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error(`"${key}" expects a non-negative integer, got "${text}".`);
    }
    return parsed;
  }
  return text;
}

function defaults() {
  const out = {};
  for (const [key, def] of Object.entries(DEFINITIONS)) out[key] = def.default;
  return out;
}

// A corrupt or hand-edited settings file must not stop the CLI from starting;
// fall back to defaults and say so rather than throwing at the user.
function load() {
  const values = defaults();
  let warning = null;

  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      const stored = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
      for (const [key, value] of Object.entries(stored)) {
        if (key in DEFINITIONS) values[key] = value;
      }
    } catch (err) {
      warning = `Could not read ${SETTINGS_PATH} (${err.message}); using defaults.`;
    }
  }

  return { values, warning };
}

function save(values) {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, `${JSON.stringify(values, null, 2)}\n`, "utf8");
}

// Settings that back an engine env var only matter if they beat what is already
// in the environment — an explicit `.env` entry the user set wins over a stale
// stored value only when the setting is still at its default.
function applyToEnv(values) {
  for (const [key, def] of Object.entries(DEFINITIONS)) {
    if (!def.env) continue;
    const value = values[key];
    if (value === null || value === undefined || value === def.default) continue;
    process.env[def.env] = String(value);
  }
}

function format(value) {
  if (value === null || value === undefined) return "(default)";
  if (typeof value === "boolean") return value ? "on" : "off";
  if (value === "") return "(empty)";
  return String(value);
}

module.exports = {
  DEFINITIONS, SETTINGS_PATH,
  defaults, load, save, applyToEnv, coerce, format,
};
