// Scheduled reminders, backed by the durable job queue.
//
// The reminder always targets the requesting user. Models will happily invent
// recipient IDs when a user says "remind everyone"; honoring those would turn a
// reminder tool into an unsolicited-message tool, so the target is taken from
// the authenticated input rather than from model arguments.
//
// Delivery is the host's job: register a "reminder" job handler that knows how
// to reach a user on your platform.

const chrono = require("chrono-node");
const { REMINDER_MAX_ACTIVE_PER_USER } = require("../../../../config.js");
const logger = require("../../../util/logger");
const jobs = require("../../../jobs");

function parseWhen(text, referenceDate = new Date()) {
  if (!text || typeof text !== "string") {
    return { ok: false, runAt: null, reason: "No time provided." };
  }
  try {
    const result = chrono.parseDate(text.trim(), referenceDate);
    if (!result) {
      return { ok: false, runAt: null, reason: `Could not understand "${text}". Try formats like "in 2 hours", "tomorrow at 3pm", or "5 minutes".` };
    }
    const runAt = result.getTime();
    if (runAt <= Date.now()) {
      return { ok: false, runAt: null, reason: "That time is in the past. Please specify a future time." };
    }
    return { ok: true, runAt, reason: null };
  } catch (err) {
    logger.warn(`[Reminders] Time parse error: ${err.message}`);
    return { ok: false, runAt: null, reason: "Failed to parse the time. Try a clearer format." };
  }
}

const setReminder = {
  name: "set_reminder",
  description: "Set a reminder for the user. They will be notified at the requested time.",
  sideEffect: true,
  parameters: {
    type: "object",
    properties: {
      when: { type: "string", description: "When to remind, e.g. 'in 2 hours', 'tomorrow at 3pm'." },
      message: { type: "string", description: "What to remind the user about." },
      frequency: { type: "string", enum: ["once", "daily", "weekly"], description: "How often to repeat. Default: once." },
      end_date: { type: "string", description: "When to stop repeating, e.g. 'in 2 weeks'." },
      occurrences: { type: "integer", description: "Maximum number of repetitions." },
    },
    required: ["when", "message"],
  },
  async handler(args, ctx) {
    const userId = ctx.input?.userId;
    if (!userId) return { error: "No user context available for this reminder." };

    const parsed = parseWhen(args.when);
    if (!parsed.ok) return { error: parsed.reason };

    const activeCount = jobs.list("reminder", row => {
      try { return JSON.parse(row.payload).userId === userId; }
      catch (_) { return false; }
    }).length;
    if (activeCount >= REMINDER_MAX_ACTIVE_PER_USER) {
      return { error: `You already have ${activeCount} active reminders. Cancel one first.` };
    }

    let recurrence = null;
    const frequency = args.frequency || "once";
    if (frequency === "daily" || frequency === "weekly") {
      const intervalMs = frequency === "daily" ? 86400000 : 604800000;
      let endAt = null;
      if (args.end_date) {
        const endParsed = parseWhen(args.end_date);
        if (endParsed.ok) endAt = endParsed.runAt;
      }
      const maxOccurrences = typeof args.occurrences === "number" && args.occurrences > 0
        ? args.occurrences
        : null;
      recurrence = { frequency, intervalMs, endAt, maxOccurrences, firedCount: 0 };
    }

    const jobId = jobs.enqueue({
      kind: "reminder",
      payload: {
        userId,
        conversationId: ctx.input?.conversationId || null,
        text: args.message,
        createdBy: "agent",
        recurrence,
      },
      run_at: parsed.runAt,
    });

    let confirm = `Reminder set for ${new Date(parsed.runAt).toISOString()}.`;
    if (recurrence) {
      confirm += ` Repeats ${recurrence.frequency}`;
      if (recurrence.endAt) confirm += ` until ${new Date(recurrence.endAt).toISOString()}`;
      else if (recurrence.maxOccurrences) confirm += ` for ${recurrence.maxOccurrences} occurrence(s)`;
      confirm += ".";
    }

    return { success: true, message: confirm, reminder_id: jobId, run_at: parsed.runAt };
  },
};

module.exports = { setReminder, parseWhen };
