// Self-critique pass: a second model reviews the draft reply for fabricated
// user-specific claims before it is treated as final.
//
// Two deliberate constraints keep this affordable and useful:
//
//   1. It is gated. Critique only fires when the reply contains something
//      falsifiable — a number, a currency figure, a date, a relative time, a
//      claim about a record. Most replies never trigger it.
//   2. It only flags claims that should have been grounded in the conversation
//      or a tool result. General world knowledge is out of scope; a reviewer
//      that flags everything trains callers to ignore it.
//
// It fails open. A critique that errors, times out, or returns garbage yields
// { ok: true } — a reliability mechanism must never be the thing that breaks a
// reply it was supposed to protect.

const { CRITIQUE_MODEL } = require("../../config.js");
const logger = require("../util/logger");
const llm = require("../llm");
const { chatWithSchema } = require("../schemas");

// Numbers, money, percentages, dates, relative times, and record/ranking words
// are the shapes a fabrication takes. Prose without any of these has little to
// hallucinate about.
const CRITIQUE_TRIGGER_RE = /(\d|\brecord\b|\brank(?:ing|ed)?\b|\bposition\b|\bstatus\b|\btoday\b|\btomorrow\b|\byesterday\b|\bin \d+ (?:second|minute|hour|day|week|month|year)s?\b|\bat \d{1,2}:\d{2}\b|\$|%)/i;

function shouldCritique(text) {
  if (!text || typeof text !== "string") return false;
  return CRITIQUE_TRIGGER_RE.test(text);
}

const REVIEWER_PROMPT =
  "You are a strict reviewer checking ONLY for fabricated context-specific claims — invented figures, " +
  "made-up record values, asserted times or statuses that contradict the tool results or the conversation. " +
  "Do NOT flag general knowledge; that does not require grounding in this conversation. " +
  "Output ONLY JSON. Schema: {\"ok\": true} when nothing context-specific is fabricated, or " +
  "{\"ok\": false, \"fix\": \"<short corrective note for the original responder>\"} when something is. " +
  "No prose outside the JSON.";

async function runCritique(originalMessages, candidateResponse) {
  try {
    const res = await chatWithSchema({
      schemaName: "critique",
      model: CRITIQUE_MODEL,
      messages: [
        { role: "system", content: REVIEWER_PROMPT },
        ...originalMessages,
        { role: "user", content: `[Candidate reply to review]\n${candidateResponse}` },
      ],
      max_tokens: 512,
      temperature: 0,
      timeoutMs: 30_000,
      label: "self-critique",
      variant: "critique",
    });
    if (res.validated && typeof res.validated.ok === "boolean") return res.validated;

    logger.warn(`[Critique] Schema validation failed: ${res.schemaError}. Treating as approved.`);
    return { ok: true };
  } catch (err) {
    logger.warn(`[Critique] Failed, treating as approved: ${err.message}`);
    return { ok: true };
  }
}

// Regenerate a flagged reply. The instruction is narrow on purpose: an
// unconstrained "fix this" turns a specific, useful answer into a hedged
// generic one, which is a worse outcome than the original inaccuracy.
async function reviseResponse(messages, originalResponse, fix, model) {
  const revision = await llm.chat({
    model,
    messages: [
      ...messages,
      { role: "assistant", content: originalResponse },
      { role: "system", content:
        `Reviewer note (apply silently — do not mention this review): ${fix}\n\n` +
        "Regenerate your reply, correcting only what the reviewer flagged. Preserve all other specific " +
        "details, names, numbers, and helpful information from your original reply. Do not make the response " +
        "more generic — only remove or qualify the specific fabricated claim. Keep the original tone and length." },
    ],
    temperature: 0.5,
    timeoutMs: 60_000,
    label: "critique-revision",
    variant: "critique_revision",
  });
  return revision.result.content?.trim() || null;
}

module.exports = { shouldCritique, runCritique, reviseResponse, CRITIQUE_TRIGGER_RE };
