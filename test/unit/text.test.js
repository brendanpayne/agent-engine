const {
  tokenize, jaccard, containsAllTokens, CORE_STOPWORDS, RETRIEVAL_STOPWORDS,
} = require("../../src/util/text");

describe("tokenize", () => {
  it("lowercases, splits on non-alphanumerics, and drops stopwords", () => {
    expect(tokenize("The quick, brown Fox!")).toEqual(["quick", "brown", "fox"]);
  });

  it("keeps two-character tokens by default", () => {
    expect(tokenize("go to db")).toContain("go");
    expect(tokenize("go to db")).toContain("db");
  });

  it("honors a raised minimum length", () => {
    expect(tokenize("go to db now", 3)).toEqual(["now"]);
  });

  it("returns an empty array for empty or nullish input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize(null)).toEqual([]);
    expect(tokenize(undefined)).toEqual([]);
  });

  it("uses the retrieval stopword set when asked", () => {
    const core = tokenize("what do you know about ramen");
    const retrieval = tokenize("what do you know about ramen", 2, RETRIEVAL_STOPWORDS);
    expect(core).toContain("what");
    expect(core).toContain("know");
    expect(retrieval).toEqual(["ramen"]);
  });
});

describe("stopword sets", () => {
  // Widening CORE silently changes fact dedup thresholds, so the split between
  // the two sets is asserted rather than left to convention.
  it("keeps content words in CORE that RETRIEVAL discards", () => {
    for (const word of ["like", "want", "know", "what", "when"]) {
      expect(CORE_STOPWORDS.has(word)).toBe(false);
      expect(RETRIEVAL_STOPWORDS.has(word)).toBe(true);
    }
  });

  it("makes RETRIEVAL a strict superset of CORE", () => {
    for (const word of CORE_STOPWORDS) expect(RETRIEVAL_STOPWORDS.has(word)).toBe(true);
    expect(RETRIEVAL_STOPWORDS.size).toBeGreaterThan(CORE_STOPWORDS.size);
  });
});

describe("jaccard", () => {
  it("scores identical strings at 1", () => {
    expect(jaccard("never spoil the answer", "never spoil the answer")).toBe(1);
  });

  it("scores disjoint strings at 0", () => {
    expect(jaccard("ramen noodles", "database migration")).toBe(0);
  });

  it("scores partial overlap between 0 and 1", () => {
    const score = jaccard("never spoil puzzle answers", "never spoil the puzzle");
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it("accepts pre-built token sets", () => {
    expect(jaccard(new Set(["ramen"]), new Set(["ramen"]))).toBe(1);
  });

  it("returns 0 when either side has no meaningful tokens", () => {
    expect(jaccard("the and of", "ramen")).toBe(0);
    expect(jaccard("", "ramen")).toBe(0);
  });
});

describe("containsAllTokens", () => {
  it("matches a short fragment naming a longer rule", () => {
    expect(containsAllTokens("Never reveal puzzle answers; give hints instead", "puzzle answers")).toBe(true);
  });

  it("is directional — the longer text is not contained in the fragment", () => {
    expect(containsAllTokens("spoilers", "Never discuss spoilers in this channel")).toBe(false);
  });

  it("rejects a fragment with any token absent", () => {
    expect(containsAllTokens("Never reveal puzzle answers", "puzzle hints")).toBe(false);
  });

  it("returns false for a fragment that is entirely stopwords", () => {
    expect(containsAllTokens("Never reveal puzzle answers", "the and of")).toBe(false);
  });
});
