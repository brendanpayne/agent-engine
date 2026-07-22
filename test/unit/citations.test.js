const {
  createCitationStore, collectCitations, applyCitations, stripUnresolvedCitations,
} = require("../../src/agent/citations");

describe("collectCitations", () => {
  it("records message ids from search_history results", () => {
    const store = createCitationStore();
    collectCitations("search_history", {
      results: [
        { result_index: 1, message_id: "m1" },
        { result_index: 2, message_id: "m2" },
      ],
    }, store);
    expect(store.msg.get(1)).toBe("m1");
    expect(store.msg.size).toBe(2);
  });

  it("records slugs from lookup_kb results", () => {
    const store = createCitationStore();
    collectCitations("lookup_kb", { results: [{ slug: "onboarding" }] }, store);
    expect(store.kb.has("onboarding")).toBe(true);
  });

  it("ignores results from unrelated tools and empty payloads", () => {
    const store = createCitationStore();
    collectCitations("web_search", { results: [{ url: "https://example.com" }] }, store);
    collectCitations("search_history", null, store);
    expect(store.msg.size).toBe(0);
    expect(store.kb.size).toBe(0);
  });
});

describe("applyCitations", () => {
  function storeWith() {
    const store = createCitationStore();
    collectCitations("search_history", { results: [{ result_index: 1, message_id: "m1" }] }, store);
    collectCitations("lookup_kb", { results: [{ slug: "policy" }] }, store);
    return store;
  }

  it("expands a known message citation", () => {
    const out = applyCitations("They shipped it [[cite:msg:1]].", storeWith());
    expect(out).toBe("They shipped it [msg:m1].");
  });

  it("expands a known knowledge-base citation", () => {
    const out = applyCitations("See the rules [[cite:kb:policy]].", storeWith());
    expect(out).toBe("See the rules (KB: policy).");
  });

  it("uses injected formatters when provided", () => {
    const out = applyCitations("Here [[cite:msg:1]].", storeWith(), {
      msg: ({ messageId }) => `<a href="/m/${messageId}">src</a>`,
    });
    expect(out).toBe("Here <a href=\"/m/m1\">src</a>.");
  });

  it("strips a citation index that was never returned", () => {
    const out = applyCitations("Claim [[cite:msg:9]].", storeWith());
    expect(out).toBe("Claim .");
  });

  it("strips a duplicate citation of the same source", () => {
    const out = applyCitations("A [[cite:msg:1]] and B [[cite:msg:1]].", storeWith());
    expect(out).toBe("A [msg:m1] and B .");
  });

  it("returns text unchanged when nothing was cited this turn", () => {
    const text = "No citations here [[cite:msg:1]].";
    expect(applyCitations(text, createCitationStore())).toBe(text);
  });
});

describe("stripUnresolvedCitations", () => {
  it("removes leftover tokens and collapses the whitespace", () => {
    expect(stripUnresolvedCitations("A claim [[cite:msg:4]] stands.")).toBe("A claim stands.");
  });

  it("leaves clean text alone", () => {
    expect(stripUnresolvedCitations("Nothing to strip.")).toBe("Nothing to strip.");
  });
});
