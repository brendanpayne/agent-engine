const path = require("path");
process.env.MEMORY_TEST_DB = path.join(__dirname, "../tmp/facts-test.sqlite");

const {
  mergeFacts, sortAndPruneFacts, scoreFacts, buildFactsBlock,
  buildMultiUserFactsBlock, valueOverlapsExisting, normalizeFactKey,
  detectConfidence, cleanupExpiredFacts, isCoreIdentityKey, resolveSubjectId,
} = require("../../src/memory/facts");

describe("normalizeFactKey", () => {
  it("lowercases, underscores spaces, and strips punctuation", () => {
    expect(normalizeFactKey("  Favorite Food! ")).toBe("favorite_food");
    expect(normalizeFactKey("job-title")).toBe("jobtitle");
  });
});

describe("detectConfidence", () => {
  it("marks hedged and joking statements low", () => {
    expect(detectConfidence("lol maybe I like pineapple")).toBe("low");
    expect(detectConfidence("I think it's fine")).toBe("low");
  });
  it("marks plain assertions high", () => {
    expect(detectConfidence("I work as a nurse in Boston")).toBe("high");
  });
});

describe("mergeFacts", () => {
  it("adds new facts with provenance", () => {
    const out = mergeFacts([], [{ key: "job", value: "nurse" }], "I am a nurse", "u1");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      key: "job", value: "nurse", confidence: "high",
      reinforcedCount: 1, subjectUserId: "u1",
    });
  });

  it("reinforces rather than duplicating an identical assertion", () => {
    const first = mergeFacts([], [{ key: "job", value: "nurse" }], "", "u1");
    const second = mergeFacts(first, [{ key: "job", value: "nurse" }], "", "u1");
    expect(second).toHaveLength(1);
    expect(second[0].reinforcedCount).toBe(2);
  });

  it("replaces the value when the same key changes", () => {
    const first = mergeFacts([], [{ key: "location", value: "Boston" }], "", "u1");
    const second = mergeFacts(first, [{ key: "location", value: "Seattle" }], "", "u1");
    expect(second).toHaveLength(1);
    expect(second[0].value).toBe("Seattle");
    expect(second[0].reinforcedCount).toBe(1);
  });

  it("keeps same-keyed facts about different subjects separate", () => {
    let out = mergeFacts([], [{ key: "allergy", value: "peanuts" }], "", "alice");
    out = mergeFacts(out, [{ key: "allergy", value: "shellfish" }], "", "bob");
    expect(out).toHaveLength(2);
    expect(out.find(f => f.subjectUserId === "alice").value).toBe("peanuts");
    expect(out.find(f => f.subjectUserId === "bob").value).toBe("shellfish");
  });

  it("removes a fact on the __deleted__ sentinel", () => {
    const first = mergeFacts([], [{ key: "sport", value: "tennis" }], "", "u1");
    const second = mergeFacts(first, [{ key: "sport", value: "__deleted__" }], "", "u1");
    expect(second).toHaveLength(0);
  });

  it("refuses to delete a pinned fact", () => {
    const pinned = [{ key: "name", value: "Alice", pinned: true, subjectUserId: "u1", updatedAt: Date.now() }];
    const out = mergeFacts(pinned, [{ key: "name", value: "__deleted__" }], "", "u1");
    expect(out).toHaveLength(1);
  });

  it("reinforces a near-duplicate value under a different key", () => {
    const first = mergeFacts([], [{ key: "favorite_drink", value: "black coffee" }], "", "u1");
    const second = mergeFacts(first, [{ key: "likes", value: "coffee black" }], "", "u1");
    expect(second).toHaveLength(1);
    expect(second[0].reinforcedCount).toBe(2);
  });

  it("ignores facts with an empty key or a trivially short value", () => {
    const out = mergeFacts([], [{ key: "", value: "x" }, { key: "a", value: "b" }], "", "u1");
    expect(out).toHaveLength(0);
  });
});

describe("valueOverlapsExisting", () => {
  it("matches on token overlap above the threshold", () => {
    const existing = [{ key: "k", value: "loves black coffee" }];
    expect(valueOverlapsExisting("black coffee loves", existing)).toBeTruthy();
  });
  it("returns null for unrelated values", () => {
    expect(valueOverlapsExisting("plays guitar", [{ key: "k", value: "lives in Berlin" }])).toBeNull();
  });
});

describe("cleanupExpiredFacts", () => {
  it("drops stale facts but keeps pinned and timestamp-less ones", () => {
    const ancient = Date.now() - 400 * 24 * 60 * 60 * 1000;
    const out = cleanupExpiredFacts([
      { key: "old", value: "x", updatedAt: ancient },
      { key: "pinned", value: "x", updatedAt: ancient, pinned: true },
      { key: "undated", value: "x" },
      { key: "fresh", value: "x", updatedAt: Date.now() },
    ]);
    expect(out.map(f => f.key).sort()).toEqual(["fresh", "pinned", "undated"]);
  });
});

describe("scoreFacts", () => {
  it("ranks recent and reinforced facts above stale ones", () => {
    const now = Date.now();
    const [stale, fresh] = scoreFacts([
      { key: "a", value: "1", updatedAt: now - 80 * 24 * 3600 * 1000, reinforcedCount: 1 },
      { key: "b", value: "2", updatedAt: now, reinforcedCount: 5 },
    ], now);
    expect(fresh._score).toBeGreaterThan(stale._score);
  });
});

describe("isCoreIdentityKey", () => {
  it("recognizes identity anchors and their prefixed variants", () => {
    expect(isCoreIdentityKey("name")).toBe(true);
    expect(isCoreIdentityKey("location_home")).toBe(true);
    expect(isCoreIdentityKey("favorite_food")).toBe(false);
  });
});

describe("buildFactsBlock", () => {
  const now = Date.now();

  it("returns an empty string with no facts", () => {
    expect(buildFactsBlock("UserFacts", [])).toBe("");
  });

  it("excludes unreinforced low-confidence facts", () => {
    const block = buildFactsBlock("UserFacts", [
      { key: "shaky", value: "maybe", confidence: "low", reinforcedCount: 1, updatedAt: now },
    ]);
    expect(block).toBe("");
  });

  it("includes a low-confidence fact once reinforced", () => {
    const block = buildFactsBlock("UserFacts", [
      { key: "shaky", value: "maybe", confidence: "low", reinforcedCount: 3, updatedAt: now },
    ]);
    expect(block).toContain("shaky: maybe");
  });

  it("always keeps core identity keys even past the budget", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      key: `misc_${i}`, value: `v${i}`, confidence: "high", reinforcedCount: 1, updatedAt: now,
    }));
    many.push({ key: "name", value: "Alice", confidence: "high", reinforcedCount: 1, updatedAt: 0 });
    const block = buildFactsBlock("UserFacts", many, 5);
    expect(block).toContain("name: Alice");
  });
});

describe("buildMultiUserFactsBlock", () => {
  it("emits one block per participant with facts", () => {
    const now = Date.now();
    const mk = v => [{ key: "k", value: v, confidence: "high", reinforcedCount: 1, updatedAt: now }];
    const block = buildMultiUserFactsBlock("u1", ["u1", "u2"], { u1: mk("a"), u2: mk("b") }, id => id);
    expect(block).toContain("id=\"u1\"");
    expect(block).toContain("id=\"u2\"");
  });

  it("skips participants with no facts", () => {
    const now = Date.now();
    const block = buildMultiUserFactsBlock("u1", ["u1", "u2"], {
      u1: [{ key: "k", value: "a", confidence: "high", reinforcedCount: 1, updatedAt: now }],
    }, id => id);
    expect(block).not.toContain("id=\"u2\"");
  });
});

describe("sortAndPruneFacts", () => {
  it("caps the set while preserving pinned facts", () => {
    const facts = Array.from({ length: 40 }, (_, i) => ({
      key: `k${i}`, value: `v${i}`, updatedAt: Date.now() - i * 1000,
    }));
    facts.push({ key: "keep", value: "always", updatedAt: 0, pinned: true });
    const out = sortAndPruneFacts(facts);
    expect(out.some(f => f.pinned)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(26);
  });
});

describe("resolveSubjectId", () => {
  const participants = {
    u2: { currentName: "Bob", namesSeen: ["Bob", "Bobby"] },
  };

  it("resolves self-references to the author", () => {
    expect(resolveSubjectId("self", "u1", "Alice", participants)).toBe("u1");
    expect(resolveSubjectId("", "u1", "Alice", participants)).toBe("u1");
    expect(resolveSubjectId("Alice", "u1", "Alice", participants)).toBe("u1");
  });

  it("resolves a named participant, including a former name", () => {
    expect(resolveSubjectId("Bob", "u1", "Alice", participants)).toBe("u2");
    expect(resolveSubjectId("Bobby", "u1", "Alice", participants)).toBe("u2");
  });

  it("falls back to the author for an unknown name", () => {
    expect(resolveSubjectId("Nobody", "u1", "Alice", participants)).toBe("u1");
  });
});
