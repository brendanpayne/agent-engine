// Participant registry: a per-conversation map of userId -> display names seen.
//
// Display names change; IDs do not. Without this registry a model watching a
// conversation where someone renamed will treat them as two different people,
// or worse, merge them with someone else. Every prompt anchors identity on the
// ID and lists former names explicitly.

const logger = require("../util/logger");
const store = require("./store");
const { mergeFacts, sortAndPruneFacts } = require("./facts");

// Participants idle longer than this are dropped from a conversation's registry.
const PARTICIPANT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Pure map transition. Given the existing registry and the participants seen
// now, returns { participants, renames }. Kept free of I/O so it is directly
// unit-testable.
function applyParticipantUpdate(participants, members, now = Date.now()) {
  const next = { ...(participants || {}) };
  const renames = [];
  for (const m of members || []) {
    const userId = m && m.userId;
    const displayName = m && m.displayName;
    if (!userId || !displayName) continue;
    const existing = next[userId];
    if (!existing) {
      next[userId] = { currentName: displayName, namesSeen: [displayName], firstSeen: now, lastSeen: now };
      continue;
    }
    const namesSeen = Array.isArray(existing.namesSeen)
      ? existing.namesSeen.slice()
      : [existing.currentName].filter(Boolean);
    if (existing.currentName !== displayName) {
      renames.push({ userId, oldName: existing.currentName, newName: displayName });
      if (!namesSeen.includes(displayName)) namesSeen.push(displayName);
    }
    next[userId] = { currentName: displayName, namesSeen, firstSeen: existing.firstSeen || now, lastSeen: now };
  }
  for (const uid of Object.keys(next)) {
    if (now - (next[uid].lastSeen || 0) > PARTICIPANT_TTL_MS) delete next[uid];
  }
  return { participants: next, renames };
}

// Persist the registry from the participants seen this turn. On a rename, also
// stamps a previous_name fact into that user's store so the identity link
// survives even if the registry entry later expires.
async function updateParticipants(conversationId, members) {
  if (!conversationId || !Array.isArray(members) || members.length === 0) return {};

  const context = store.getConversation(conversationId);
  const { participants, renames } = applyParticipantUpdate(context.participants, members);
  await store.updateConversation(conversationId, { participants });

  for (const r of renames) {
    try {
      const data = store.getUser(r.userId);
      const merged = mergeFacts(
        data.facts || [],
        [{ key: "previous_name", value: r.oldName, confidence: "high" }],
        `rename:${r.oldName}->${r.newName}`,
        r.userId,
      );
      await store.updateUser(r.userId, { facts: sortAndPruneFacts(merged) });
      logger.info(`[Identity] ${r.userId} renamed "${r.oldName}" -> "${r.newName}"; recorded previous_name`);
    } catch (err) {
      logger.warn(`[Identity] Failed to record rename for ${r.userId}: ${err.message}`);
    }
  }
  return participants;
}

// Roster of who is present this turn. Dynamic (it changes as people speak), so
// it is injected late in the prompt where it won't disturb the cached prefix.
function buildParticipantsBlock(participants, presentIds) {
  if (!participants) return "";
  const seen = new Set();
  const lines = [];
  for (const uid of presentIds || []) {
    if (seen.has(uid)) continue;
    seen.add(uid);
    const p = participants[uid];
    if (!p) continue;
    const others = Array.isArray(p.namesSeen) ? p.namesSeen.filter(n => n !== p.currentName) : [];
    const aka = others.length > 0 ? ` (aka ${others.join(", ")})` : "";
    lines.push(`${p.currentName} (user_${uid})${aka}: present`);
  }
  if (lines.length === 0) return "";
  return `[Participants]\n${lines.join("\n")}`;
}

module.exports = {
  applyParticipantUpdate, updateParticipants, buildParticipantsBlock,
  PARTICIPANT_TTL_MS,
};
