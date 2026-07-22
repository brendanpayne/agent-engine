// Split long text into chunks at word boundaries. Hosts with a per-message
// length ceiling (chat platforms, SMS) pass their own limit; the engine itself
// never assumes one.

function splitAtWordBoundary(text, maxLength) {
  if (!text) return [];
  if (!maxLength || text.length <= maxLength) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitIndex = remaining.lastIndexOf(" ", maxLength - 1);

    // No usable space near the limit means a single very long word — hard-split.
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      splitIndex = maxLength - 1;
    }

    chunks.push(remaining.slice(0, splitIndex + 1).trim());
    remaining = remaining.slice(splitIndex + 1).trim();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

module.exports = { splitAtWordBoundary };
