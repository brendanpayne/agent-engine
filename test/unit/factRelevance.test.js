const path = require("path");
process.env.MEMORY_TEST_DB = path.join(__dirname, "../tmp/fact-relevance-test.sqlite");

const {
  scoreFacts, relevanceScore, buildCueTokens, cueSlice, buildFactsBlock,
} = require("../../src/memory/facts");

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

const fact = (key, value, daysOld = 0, reinforcedCount = 1) => ({
  key, value, updatedAt: NOW - daysOld * DAY, reinforcedCount, confidence: "high",
});

describe("buildCueTokens", () => {
  it("unions tokens across every supplied text", () => {
    const tokens = buildCueTokens("what is my cat called", "a photo of a tabby");
    expect(tokens.has("cat")).toBe(true);
    expect(tokens.has("tabby")).toBe(true);
  });

  it("drops stopwords and skips nullish inputs", () => {
    const tokens = buildCueTokens("the cat", null, undefined, "");
    expect([...tokens]).toEqual(["cat"]);
  });

  it("returns an empty set for no usable input", () => {
    expect(buildCueTokens().size).toBe(0);
    expect(buildCueTokens("the and of").size).toBe(0);
  });
});

describe("cueSlice", () => {
  it("truncates a long perception payload", () => {
    expect(cueSlice("x".repeat(1000))).toHaveLength(300);
  });

  it("passes short strings and non-strings through", () => {
    expect(cueSlice("short")).toBe("short");
    expect(cueSlice(null)).toBeNull();
    expect(cueSlice(undefined)).toBeUndefined();
  });
});

describe("relevanceScore", () => {
  it("scores a key hit above a value hit", () => {
    const cues = new Set(["cat"]);
    const keyHit = relevanceScore(fact("pet_cat_name", "Mittens"), cues);
    const valueHit = relevanceScore(fact("favorite_animal", "cat"), cues);
    expect(keyHit).toBeGreaterThan(valueHit);
    expect(valueHit).toBeGreaterThan(0);
  });

  it("scores 0 with no overlap and no cues", () => {
    expect(relevanceScore(fact("job", "nurse"), new Set(["ramen"]))).toBe(0);
    expect(relevanceScore(fact("job", "nurse"), new Set())).toBe(0);
    expect(relevanceScore(fact("job", "nurse"), null)).toBe(0);
  });

  it("counts a token once, against the key rather than the value", () => {
    // "cat" appears in both halves; the key hit takes precedence and the value
    // must not double-count it.
    expect(relevanceScore(fact("cat", "cat"), new Set(["cat"]))).toBeCloseTo(0.6, 5);
  });

  it("caps at 1 for a fact hit by many cues", () => {
    const cues = new Set(["cat", "mittens", "tabby", "vet"]);
    expect(relevanceScore(fact("cat_tabby", "mittens vet"), cues)).toBe(1);
  });
});

describe("scoreFacts with cue tokens", () => {
  it("is unchanged when no cues are supplied", () => {
    const facts = [fact("job", "nurse", 0, 5)];
    expect(scoreFacts(facts, NOW)[0]._score).toBeCloseTo(scoreFacts(facts, NOW, new Set())[0]._score, 10);
  });

  it("lifts a stale relevant fact above a fresh irrelevant one", () => {
    const stale = fact("pet_cat_name", "Mittens", 80);
    const fresh = fact("last_meal", "pizza", 0);
    const withoutCues = scoreFacts([stale, fresh], NOW).sort((a, b) => b._score - a._score);
    expect(withoutCues[0].key).toBe("last_meal");

    const withCues = scoreFacts([stale, fresh], NOW, new Set(["cat"])).sort((a, b) => b._score - a._score);
    expect(withCues[0].key).toBe("pet_cat_name");
  });

  it("leaves relative order intact among equally irrelevant facts", () => {
    const older = fact("a_key", "alpha", 60);
    const newer = fact("b_key", "beta", 1);
    const scored = scoreFacts([older, newer], NOW, new Set(["ramen"])).sort((a, b) => b._score - a._score);
    expect(scored[0].key).toBe("b_key");
  });
});

describe("buildFactsBlock with cue tokens", () => {
  it("spends its budget on facts about the current turn", () => {
    const facts = [
      fact("pet_cat_name", "Mittens", 80),
      ...Array.from({ length: 20 }, (_, i) => fact(`chatter_${i}`, `topic ${i}`, 0)),
    ];
    const withoutCues = buildFactsBlock("UserFacts", facts, 5);
    expect(withoutCues).not.toContain("pet_cat_name");

    const withCues = buildFactsBlock("UserFacts", facts, 5, new Set(["cat"]));
    expect(withCues).toContain("pet_cat_name: Mittens");
  });

  it("still emits core identity facts regardless of cues", () => {
    const facts = [fact("name", "Ada", 200), fact("pet_cat_name", "Mittens", 1)];
    const block = buildFactsBlock("UserFacts", facts, 1, new Set(["cat"]));
    expect(block).toContain("name: Ada");
  });
});
