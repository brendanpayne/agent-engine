// Console + rolling file logger. File output is grouped as
// <LOG_DIR>/YYYY/MM/DD.txt and can be disabled entirely with LOG_TO_FILE=false
// (useful for read-only filesystems and test runs).

const fs = require("fs");
const path = require("path");
const config = require("../../config.js");

const DEBUG_LOGGING = config.DEBUG_LOGGING || process.argv.includes("debug");

const COLORS = {
  info: "\x1b[32m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
  debug: "\x1b[36m",
};
const RESET = "\x1b[0m";
// Console colors must not reach the log file. The escape byte is a control
// character by definition, so the lint rule against them does not apply here.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[\d+m/g;

function logToFile(message, type) {
  if (!config.LOG_TO_FILE) return;
  try {
    const text = typeof message === "string" ? message : (message?.stack || JSON.stringify(message));
    const date = new Date();
    const yyyy = String(date.getFullYear());
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    const dir = path.resolve(process.cwd(), config.LOG_DIR, yyyy, mm);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const line = `[${date.toISOString()}] [${type.toUpperCase()}] ${text.replace(ANSI_RE, "")}\n`;
    fs.appendFile(path.join(dir, `${dd}.txt`), line, () => {});
  } catch (_) {
    // Logging must never take the process down.
  }
}

function emit(type, message) {
  if (type === "debug" && !DEBUG_LOGGING) return;
  const text = typeof message === "string"
    ? message
    : (message?.stack || JSON.stringify(message));
  console.log(`${COLORS[type] || COLORS.info}[${type.toUpperCase()}]${RESET} ${text}`);
  logToFile(message, type);
}

module.exports = {
  log: (message, type = "info") => emit(COLORS[type] ? type : "info", message),
  info: message => emit("info", message),
  debug: message => emit("debug", message),
  warn: message => emit("warn", message),
  error: message => emit("error", message),
};
