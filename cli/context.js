// Per-channel roleplay context.
//
// The chat bot this CLI descends from let you set a character per thread — five
// named fields that replaced the system persona while you were in that thread.
// This is that feature, kept in the client where it belongs: the engine already
// takes a persona override per turn, so nothing below needs engine support.
//
// The fields are deliberately the original five. They are not a schema the model
// sees; each one becomes a labelled line in the prompt, and an unset field
// contributes nothing at all rather than an empty heading.

// Discord capped each field at 1024 characters (the limit on an embed field
// value). Keeping the cap means a context written for the bot still fits here,
// and it stops one runaway field from crowding out the rest of the prompt.
const MAX_FIELD_LENGTH = 1024;

const FIELDS = [
  {
    key: "characteristics",
    label: "Characteristics",
    prompt: v => `Characteristics: ${v}`,
    describe: "Appearance and defining traits",
    example: "medium blonde hair with a thick beard, always in a work jacket",
  },
  {
    key: "personality",
    label: "Personality",
    prompt: v => `Your personality: ${v}`,
    describe: "Temperament and how they behave",
    example: "gruff but fair, slow to trust, dry about it",
  },
  {
    key: "preferences",
    label: "Preferences",
    prompt: v => `Your preferences: ${v}`,
    describe: "Likes, dislikes, what drives them",
    example: "hates corporate suits, lives for shift-end whisky",
  },
  {
    key: "dialog",
    label: "Dialog",
    prompt: v => `Dialog tone: ${v}`,
    describe: "Speech register, verbal tics, whether to use emotes",
    example: "clipped sentences, station slang, no *stage directions*",
  },
  {
    key: "boundaries",
    label: "Boundaries",
    prompt: v => `Your boundaries: ${v}`,
    describe: "Limits the character will not cross",
    example: "never discusses the war, will not threaten anyone",
  },
];

const KEYS = FIELDS.map(f => f.key);

function field(key) {
  return FIELDS.find(f => f.key === String(key).toLowerCase()) || null;
}

function empty() {
  const out = {};
  for (const key of KEYS) out[key] = "";
  return out;
}

function isSet(context) {
  if (!context) return false;
  return KEYS.some(key => String(context[key] || "").trim() !== "");
}

// Which fields actually carry something, in declaration order.
function filled(context) {
  return FIELDS.filter(f => String(context?.[f.key] || "").trim() !== "");
}

// The persona block handed to the engine as options.persona, replacing the
// default persona for turns in this channel.
//
// "Stay in character" is carried over from the original; the compliance
// override that sat next to it there is not — see the note in the README. The
// boundaries line is stated last of the character fields and reinforced after,
// because a boundary the character keeps is the one thing here that should win
// against the rest of the description.
function buildPersona(context, { channelName, topic } = {}) {
  if (!isSet(context)) return null;

  const lines = [
    `You are roleplaying as a character in a chat channel called "#${channelName || "channel"}".`,
    "",
    "[Roleplay Data]",
    ...filled(context).map(f => f.prompt(String(context[f.key]).trim())),
  ];

  if (topic && topic.trim()) lines.push("", `Background:\n${topic.trim()}`);

  lines.push(
    "",
    "Stay in character. Do not mention that you are an AI assistant unless you are asked directly.",
    // Deliberately no rule about emotes or stage directions. The original had
    // none, models ignore one when the character invites it, and it is the sort
    // of thing a roleplayer may well want — so it belongs in the dialog field,
    // where the user decides, rather than hardcoded here.
    //
    // Incoming messages arrive as `[user_<id>] Name: text`. A persona that tells
    // the model to imitate a voice will cheerfully imitate that envelope too and
    // open its reply with a speaker anchor — the default persona never says not
    // to, so a persona that replaces it has to.
    "Write only the character's own words. Never prefix your reply with a name, a [user_...] anchor, or any other speaker label.",
  );
  if (String(context.boundaries || "").trim()) {
    lines.push("Hold to the boundaries above. They outrank every other part of the character.");
  }

  return lines.join("\n");
}

// Truncate rather than reject: a pasted description that runs long should still
// take, minus the tail, instead of making the user edit it down by hand.
function coerceValue(raw) {
  const text = String(raw ?? "").trim();
  return text.length > MAX_FIELD_LENGTH ? text.slice(0, MAX_FIELD_LENGTH) : text;
}

module.exports = {
  FIELDS, KEYS, MAX_FIELD_LENGTH,
  field, empty, isSet, filled, buildPersona, coerceValue,
};
