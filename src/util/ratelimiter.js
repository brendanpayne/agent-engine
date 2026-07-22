// In-memory rate limiting for per-user agent turns and image generation.
//
// Denials return a machine-readable `retryAt` (unix seconds) plus a plain-text
// `reason`. Formatting that into whatever the host UI wants — a countdown, a
// relative timestamp, a disabled button — is the host's job, not the engine's.
//
// State is process-local and resets on restart. That is deliberate: these are
// abuse dampeners, not billing quotas.

const logger = require("./logger");
const {
  IMAGE_GEN_LIMIT,
  IMAGE_GEN_WINDOW,
  TURN_INFLIGHT_TIMEOUT_MS,
  TURN_BURST_LIMIT,
  TURN_BURST_WINDOW_MS,
} = require("../../config.js");

const imageGenTimestamps = new Map();

// Per-user turn state for the reply-gated + burst-cap throttler.
// Shape: { inFlight: boolean, inFlightSince: number, turns: number[] }
const agentTurns = new Map();

function canGenerateImage(userId) {
  const now = Date.now();
  const windowMs = IMAGE_GEN_WINDOW * 1000;
  const history = (imageGenTimestamps.get(userId) || []).filter(ts => now - ts < windowMs);

  if (history.length >= IMAGE_GEN_LIMIT) {
    const retryIn = Math.ceil((windowMs - (now - history[0])) / 1000);
    imageGenTimestamps.set(userId, history);
    return {
      allowed: false,
      reason: `Image generation limit reached (${IMAGE_GEN_LIMIT} per ${Math.round(IMAGE_GEN_WINDOW / 60)} min).`,
      retryIn,
      retryAt: Math.floor(now / 1000) + retryIn,
    };
  }

  history.push(now);
  imageGenTimestamps.set(userId, history);
  return { allowed: true };
}

// Reply-gated + burst-cap turn throttle. Two independent guards:
//   1. In-flight gate: a user cannot start a new turn until the previous one
//      finished (or the stale timeout fires, so a thrown handler doesn't
//      permanently jam that user).
//   2. Burst cap: rolling window of completed turns, to stop long-tail abuse.
//
// Call `beginTurn(userId)` BEFORE handing the input to the agent. If allowed,
// the caller MUST eventually invoke `endTurn(userId)` — wrap the handler in
// try/finally so a thrown error still releases the gate.
function beginTurn(userId) {
  const now = Date.now();
  const state = agentTurns.get(userId) || { inFlight: false, inFlightSince: 0, turns: [] };

  if (state.inFlight) {
    const elapsed = now - state.inFlightSince;
    if (elapsed < TURN_INFLIGHT_TIMEOUT_MS) {
      return {
        allowed: false,
        reason: "Your previous turn is still being processed.",
        retryAt: Math.floor((state.inFlightSince + TURN_INFLIGHT_TIMEOUT_MS) / 1000),
      };
    }
    // Stale in-flight: the previous turn never called endTurn (handler threw
    // upstream, or the process restarted mid-turn). Reset and let this one
    // through; log so the leak is visible.
    logger.warn(`[Turn] Stale in-flight for user ${userId} (${elapsed}ms); auto-clearing.`);
    state.inFlight = false;
  }

  state.turns = state.turns.filter(ts => now - ts < TURN_BURST_WINDOW_MS);
  if (state.turns.length >= TURN_BURST_LIMIT) {
    agentTurns.set(userId, state);
    return {
      allowed: false,
      reason: `Burst limit reached (${TURN_BURST_LIMIT} turns per ${Math.round(TURN_BURST_WINDOW_MS / 60000)} min).`,
      retryAt: Math.floor((state.turns[0] + TURN_BURST_WINDOW_MS) / 1000),
    };
  }

  state.inFlight = true;
  state.inFlightSince = now;
  agentTurns.set(userId, state);
  return { allowed: true };
}

function endTurn(userId) {
  const state = agentTurns.get(userId);
  if (!state) return;
  state.inFlight = false;
  state.inFlightSince = 0;
  state.turns.push(Date.now());
  // Cheap bound: trim to the window each end-of-turn so the array never grows
  // past TURN_BURST_LIMIT for an active user.
  const cutoff = Date.now() - TURN_BURST_WINDOW_MS;
  state.turns = state.turns.filter(ts => ts >= cutoff);
  agentTurns.set(userId, state);
}

function reset() {
  imageGenTimestamps.clear();
  agentTurns.clear();
}

module.exports = { canGenerateImage, beginTurn, endTurn, reset };
