const path = require("path");
process.env.MEMORY_TEST_DB = path.join(__dirname, "../tmp/directives-test.sqlite");

const {
  mergeDirectives, removeDirective, buildDirectivesBlock, DIRECTIVE_KEYWORDS,
} = require("../../src/memory/directives");

describe("mergeDirectives", () => {
  it("adds a new directive with provenance", () => {
    const { directives, added } = mergeDirectives([], ["Never reveal puzzle answers."], {
      createdBy: "u1", source: "tool", now: 1000,
    });
    expect(directives).toHaveLength(1);
    expect(added).toHaveLength(1);
    expect(directives[0]).toMatchObject({
      text: "Never reveal puzzle answers.",
      createdBy: "u1",
      source: "tool",
      createdAt: 1000,
      updatedAt: 1000,
    });
    expect(directives[0].id).toHaveLength(6);
  });

  it("refreshes a near-duplicate instead of stacking a second copy", () => {
    const first = mergeDirectives([], ["Never reveal puzzle answers"], { now: 1000 });
    const second = mergeDirectives(first.directives, ["never reveal puzzle answers"], { now: 2000 });
    expect(second.directives).toHaveLength(1);
    expect(second.added).toHaveLength(0);
    expect(second.reinforced).toEqual([first.directives[0].id]);
    expect(second.directives[0].updatedAt).toBe(2000);
  });

  it("keeps genuinely different rules separate", () => {
    const first = mergeDirectives([], ["Never reveal puzzle answers"]);
    const second = mergeDirectives(first.directives, ["Keep replies under three sentences"]);
    expect(second.directives).toHaveLength(2);
    expect(second.added).toHaveLength(1);
  });

  it("normalizes whitespace and caps length", () => {
    const long = "x".repeat(500);
    const { directives } = mergeDirectives([], [`  never   say    ${long}  `]);
    expect(directives[0].text.length).toBe(300);
    expect(directives[0].text.startsWith("never say x")).toBe(true);
  });

  it("skips entries that are too short to be a rule", () => {
    const { directives, added } = mergeDirectives([], ["no", "", null, "  "]);
    expect(directives).toHaveLength(0);
    expect(added).toHaveLength(0);
  });

  it("accepts directive objects as well as strings", () => {
    const { directives } = mergeDirectives([], [{ text: "Keep replies short" }]);
    expect(directives[0].text).toBe("Keep replies short");
  });

  it("evicts the oldest entries past the cap", () => {
    // Distinct subjects, not numbered variants of one sentence — near-identical
    // wording would be deduplicated before the cap ever came into play.
    const subjects = [
      "spoilers", "recipes", "deadlines", "pricing", "weather",
      "sports", "politics", "music", "travel", "hardware",
      "gardening", "astronomy",
    ];
    let directives = [];
    for (const subject of subjects) {
      directives = mergeDirectives(directives, [`Never discuss ${subject}`]).directives;
    }
    expect(directives).toHaveLength(10);
    // The two oldest are gone; the newest survives.
    expect(directives[0].text).toBe("Never discuss deadlines");
    expect(directives[9].text).toBe("Never discuss astronomy");
  });

  it("does not mutate the input array", () => {
    const existing = mergeDirectives([], ["Never reveal puzzle answers"]).directives;
    const snapshot = JSON.parse(JSON.stringify(existing));
    mergeDirectives(existing, ["never reveal puzzle answers"], { now: 9999 });
    expect(existing).toEqual(snapshot);
  });

  it("tolerates a non-array or empty incoming set", () => {
    const existing = mergeDirectives([], ["Never reveal puzzle answers"]).directives;
    expect(mergeDirectives(existing, null).directives).toHaveLength(1);
    expect(mergeDirectives(existing, []).added).toHaveLength(0);
  });
});

describe("removeDirective", () => {
  const seed = () => mergeDirectives([], [
    "Never reveal the answer to word games; give hints only when asked",
    "Keep replies under three sentences",
  ]).directives;

  it("removes by id", () => {
    const existing = seed();
    const { directives, removed } = removeDirective(existing, existing[0].id);
    expect(removed.text).toContain("word games");
    expect(directives).toHaveLength(1);
  });

  it("removes by exact text, case-insensitively", () => {
    const existing = seed();
    const { removed } = removeDirective(existing, "keep replies under three sentences");
    expect(removed.text).toBe("Keep replies under three sentences");
  });

  it("removes by a naming fragment that Jaccard alone would miss", () => {
    const existing = seed();
    const { removed } = removeDirective(existing, "word games");
    expect(removed.text).toContain("word games");
  });

  it("removes by a close paraphrase", () => {
    const existing = mergeDirectives([], ["Keep replies under three sentences"]).directives;
    const { removed } = removeDirective(existing, "keep replies short, under three sentences");
    expect(removed).not.toBeNull();
    expect(removed.text).toBe("Keep replies under three sentences");
  });

  it("returns null when nothing matches", () => {
    const existing = seed();
    const { directives, removed } = removeDirective(existing, "something entirely unrelated");
    expect(removed).toBeNull();
    expect(directives).toHaveLength(2);
  });

  it("returns null for empty input", () => {
    expect(removeDirective(seed(), "").removed).toBeNull();
    expect(removeDirective(null, "anything").removed).toBeNull();
  });
});

describe("buildDirectivesBlock", () => {
  it("returns empty string when there are no directives", () => {
    expect(buildDirectivesBlock([])).toBe("");
    expect(buildDirectivesBlock(null)).toBe("");
    expect(buildDirectivesBlock([null, {}])).toBe("");
  });

  it("renders numbered rules with their ids", () => {
    const directives = mergeDirectives([], ["Never reveal puzzle answers"]).directives;
    const block = buildDirectivesBlock(directives);
    expect(block).toContain("[Standing Instructions]");
    expect(block).toContain(`1. (${directives[0].id}) Never reveal puzzle answers`);
  });
});

describe("DIRECTIVE_KEYWORDS gate", () => {
  const passes = [
    "from now on keep your replies short",
    "never spoil the answer, just give hints",
    "always tell me the source when you quote something",
    "stop posting links in every reply",
    "remember to mention the deadline whenever i ask",
    "every time i say go, reply with a summary",
    "whenever i ask about spoilers, say nothing",
    "forget that rule about spoilers",
    "you can now discuss spoilers",
  ];
  const rejects = [
    "i always lose at slots",
    "never mind",
    "i never eat breakfast",
    "what did we decide about the migration",
    "lol that was always going to happen",
    "stop it",
  ];

  it.each(passes)("gates in: %s", text => {
    expect(DIRECTIVE_KEYWORDS.test(text)).toBe(true);
  });

  it.each(rejects)("gates out: %s", text => {
    expect(DIRECTIVE_KEYWORDS.test(text)).toBe(false);
  });
});
