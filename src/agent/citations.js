// Citation collection and expansion.
//
// The model emits [[cite:msg:N]] / [[cite:kb:slug]] tokens inline. N indexes the
// results a retrieval tool actually returned this turn, so a token referencing
// an index that was never returned is a fabricated citation and gets stripped
// rather than rendered — the whole point of citations is that they are checkable.
//
// Rendering is injectable: the engine has no idea whether a citation should
// become a deep link, a footnote, or a bare marker.

// Record which results a retrieval tool returned so tokens can be resolved
// after the loop finishes.
function collectCitations(toolName, toolResult, citationStore) {
  if (!toolResult?.results?.length) return;
  if (toolName === "search_history") {
    for (const r of toolResult.results) {
      if (r.result_index !== null && r.result_index !== undefined && r.message_id) {
        citationStore.msg.set(r.result_index, r.message_id);
      }
    }
  } else if (toolName === "lookup_kb") {
    for (const r of toolResult.results) {
      if (r.slug) citationStore.kb.add(r.slug);
    }
  }
}

function createCitationStore() {
  return { msg: new Map(), kb: new Set() };
}

// Default renderers produce plain, platform-neutral markers.
const defaultFormatters = {
  msg: ({ messageId }) => `[msg:${messageId}]`,
  kb: ({ slug }) => `(KB: ${slug})`,
};

// Expand tokens into rendered citations. Unknown or duplicate tokens are
// removed: a repeated citation adds noise, and an unknown one is a hallucination.
function applyCitations(text, citationStore, formatters = {}) {
  if (!text || (citationStore.msg.size === 0 && citationStore.kb.size === 0)) return text;
  const render = { ...defaultFormatters, ...formatters };
  const seenMsg = new Set();
  const seenKb = new Set();

  return text.replace(/\[\[cite:(msg|kb):([^\]]+)\]\]/g, (match, type, ref) => {
    if (type === "msg") {
      const idx = parseInt(ref, 10);
      if (isNaN(idx) || !citationStore.msg.has(idx) || seenMsg.has(idx)) return "";
      seenMsg.add(idx);
      return render.msg({ index: idx, messageId: citationStore.msg.get(idx) });
    }
    const slug = ref.trim();
    if (!citationStore.kb.has(slug) || seenKb.has(slug)) return "";
    seenKb.add(slug);
    return render.kb({ slug });
  });
}

// Any token still present after expansion referenced something that was never
// retrieved. Strip them so a fabricated citation never reaches a user.
function stripUnresolvedCitations(text) {
  if (!text) return text;
  return text.replace(/\[\[cite:[^\]]*\]\]/g, "").replace(/\s{2,}/g, " ").trim();
}

module.exports = { collectCitations, createCitationStore, applyCitations, stripUnresolvedCitations };
