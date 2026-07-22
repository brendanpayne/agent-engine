const path = require("path");
const fs = require("fs");

const TMP = path.join(__dirname, "../tmp");
fs.mkdirSync(TMP, { recursive: true });

process.env.MEMORY_TEST_DB = path.join(TMP, "stores-memory.sqlite");
process.env.KB_TEST_DB = path.join(TMP, "stores-kb.sqlite");
process.env.ARCHIVE_TEST_DB = path.join(TMP, "stores-archive.sqlite");
process.env.EPISODES_TEST_DB = path.join(TMP, "stores-episodes.sqlite");

const memoryStore = require("../../src/memory/store");
const kb = require("../../src/kb");
const archive = require("../../src/archive");
const episodes = require("../../src/episodes");
const { applyParticipantUpdate, buildParticipantsBlock } = require("../../src/memory/participants");

afterAll(() => {
  memoryStore.close();
  kb.close();
  kb.proposals.close();
  archive.close();
  episodes.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("memory store", () => {
  it("creates a conversation lazily with defaults", () => {
    const ctx = memoryStore.getConversation("conv-1", "First");
    expect(ctx.id).toBe("conv-1");
    expect(ctx.facts).toEqual([]);
    expect(ctx.summaries).toEqual([]);
    expect(ctx.messagesSinceSummary).toBe(0);
  });

  it("round-trips facts and counters", async () => {
    await memoryStore.updateConversation("conv-1", {
      facts: [{ key: "k", value: "v" }],
      messagesSinceSummary: 7,
      topic: "migrations",
    });
    const ctx = memoryStore.getConversation("conv-1");
    expect(ctx.facts).toEqual([{ key: "k", value: "v" }]);
    expect(ctx.messagesSinceSummary).toBe(7);
    expect(ctx.topic).toBe("migrations");
  });

  it("stamps the owner id onto legacy user facts on read", async () => {
    await memoryStore.updateUser("user-1", { facts: [{ key: "job", value: "nurse" }] });
    expect(memoryStore.getUser("user-1").facts[0].subjectUserId).toBe("user-1");
  });

  it("blocks memory writes for an incognito user but allows flag changes", async () => {
    await memoryStore.updateUser("user-2", { facts: [{ key: "a", value: "1" }] });
    await memoryStore.updateUser("user-2", { incognito: true });
    await memoryStore.updateUser("user-2", { facts: [{ key: "b", value: "2" }] });

    const data = memoryStore.getUser("user-2");
    expect(data.incognito).toBe(true);
    expect(data.facts).toHaveLength(1);
    expect(data.facts[0].key).toBe("a");

    await memoryStore.updateUser("user-2", { incognito: false });
    expect(memoryStore.getUser("user-2").incognito).toBe(false);
  });

  it("reports per-conversation incognito", async () => {
    await memoryStore.updateUser("user-3", { incognitoConversations: ["conv-x"] });
    expect(memoryStore.isIncognito("user-3", "conv-x")).toBe(true);
    expect(memoryStore.isIncognito("user-3", "conv-y")).toBe(false);
  });
});

describe("knowledge base store", () => {
  it("creates, reads, updates, and deletes an entry", async () => {
    await kb.create({
      scopeId: "s1", slug: "onboarding", title: "Onboarding",
      content: "Steps to onboard.", creatorId: "admin",
    });

    expect(kb.getBySlug("s1", "onboarding").title).toBe("Onboarding");
    expect(kb.listForScope("s1")).toHaveLength(1);
    expect(kb.getBySlug("s2", "onboarding")).toBeNull();

    await kb.update({ scopeId: "s1", slug: "onboarding", content: "Revised steps." });
    expect(kb.getBySlug("s1", "onboarding").content).toBe("Revised steps.");

    expect(kb.deleteBySlug("s1", "onboarding")).toBe(true);
    expect(kb.getBySlug("s1", "onboarding")).toBeNull();
  });

  it("clears the embedding when content changes so it gets re-embedded", async () => {
    await kb.create({
      scopeId: "s1", slug: "policy", title: "Policy",
      content: "Original.", creatorId: "admin",
    });
    kb.setEmbedding("s1", "policy", new Float32Array([0.1, 0.2, 0.3]));
    expect(kb.getBySlug("s1", "policy").embedding).not.toBeNull();

    await kb.update({ scopeId: "s1", slug: "policy", content: "Changed." });
    expect(kb.getBySlug("s1", "policy").embedding).toBeNull();
    expect(kb.getUnembedded().some(r => r.slug === "policy")).toBe(true);
  });

  it("ranks semantic search results by cosine similarity", async () => {
    await kb.create({ scopeId: "s2", slug: "a", title: "A", content: "a", creatorId: "admin" });
    await kb.create({ scopeId: "s2", slug: "b", title: "B", content: "b", creatorId: "admin" });
    kb.setEmbedding("s2", "a", new Float32Array([1, 0, 0]));
    kb.setEmbedding("s2", "b", new Float32Array([0, 1, 0]));

    const results = kb.search("s2", new Float32Array([0.9, 0.1, 0]), 2);
    expect(results[0].slug).toBe("a");
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it("skips entries embedded with a different dimensionality", async () => {
    await kb.create({ scopeId: "s3", slug: "mismatched", title: "M", content: "m", creatorId: "admin" });
    kb.setEmbedding("s3", "mismatched", new Float32Array([1, 0]));
    expect(kb.search("s3", new Float32Array([1, 0, 0]), 3)).toHaveLength(0);
  });
});

describe("knowledge base proposals", () => {
  it("queues a proposal and de-duplicates an identical resubmission", () => {
    const first = kb.proposals.propose({
      scopeId: "s1", title: "Deploy process", content: "Run the pipeline.",
    });
    expect(first.status).toBe("pending");

    // Same content, different whitespace and case: still a duplicate.
    expect(kb.proposals.propose({
      scopeId: "s1", title: "deploy   process", content: "Run the  pipeline.",
    })).toBeNull();

    expect(kb.proposals.listPending("s1")).toHaveLength(1);
  });

  it("promotes an approved proposal into the knowledge base", async () => {
    const proposal = kb.proposals.propose({
      scopeId: "s4", title: "Runbook", content: "How to recover.",
    });
    const result = await kb.proposals.approve(proposal.id, "reviewer-1");

    expect(result.ok).toBe(true);
    expect(kb.getBySlug("s4", "runbook").content).toBe("How to recover.");
    expect(kb.proposals.getById(proposal.id).status).toBe("approved");
    expect(kb.proposals.listPending("s4")).toHaveLength(0);
  });

  it("refuses to approve the same proposal twice", async () => {
    const proposal = kb.proposals.propose({ scopeId: "s5", title: "Once", content: "Only once." });
    await kb.proposals.approve(proposal.id, "reviewer-1");
    const second = await kb.proposals.approve(proposal.id, "reviewer-1");
    expect(second.ok).toBe(false);
    expect(second.reason).toMatch(/already approved/);
  });

  it("rejects a proposal without writing to the knowledge base", () => {
    const proposal = kb.proposals.propose({ scopeId: "s6", title: "Nope", content: "Bad info." });
    expect(kb.proposals.reject(proposal.id, "reviewer-1").ok).toBe(true);
    expect(kb.getBySlug("s6", "nope")).toBeNull();
    expect(kb.proposals.reject(proposal.id, "reviewer-1").ok).toBe(false);
  });
});

describe("archive store", () => {
  it("inserts chunks and ignores duplicates by message id", () => {
    const id = archive.insertChunk({
      conversationId: "c1", messageId: "m1", authorId: "u1",
      content: "the deployment pipeline broke", createdAt: Date.now(),
    });
    expect(id).not.toBeNull();
    expect(archive.insertChunk({
      conversationId: "c1", messageId: "m1", authorId: "u1", content: "dup",
    })).toBeNull();
    expect(archive.countForConversation("c1")).toBe(1);
  });

  it("finds chunks by keyword and scopes results per conversation", () => {
    archive.insertChunk({
      conversationId: "c2", messageId: "m2", authorId: "u1",
      content: "we migrated the database", createdAt: Date.now(),
    });
    expect(archive.searchFTS("c2", "migrated", 10)).toHaveLength(1);
    expect(archive.searchFTS("c1", "migrated", 10)).toHaveLength(0);
  });

  it("removes chunks from both the table and the search index", () => {
    const id = archive.insertChunk({
      conversationId: "c3", messageId: "m3", authorId: "u1",
      content: "ephemeral note", createdAt: Date.now(),
    });
    expect(archive.deleteChunks([id])).toBe(1);
    expect(archive.searchFTS("c3", "ephemeral", 10)).toHaveLength(0);
  });

  it("prunes by age and by per-conversation cap", () => {
    const old = Date.now() - 200 * 86400000;
    archive.insertChunk({ conversationId: "c4", messageId: "old1", authorId: "u1", content: "ancient", createdAt: old });
    for (let i = 0; i < 5; i++) {
      archive.insertChunk({
        conversationId: "c5", messageId: `n${i}`, authorId: "u1",
        content: `note ${i}`, createdAt: Date.now() + i,
      });
    }
    const result = archive.prune({ retentionDays: 90, maxRowsPerConversation: 2 });
    expect(result.deletedByAge).toBeGreaterThanOrEqual(1);
    expect(archive.countForConversation("c5")).toBe(2);
  });
});

describe("episode store", () => {
  it("adds an episode retrievable by keyword", () => {
    const id = episodes.addEpisode({
      scopeType: "conversation", scopeId: "c1",
      summary: "The team shipped the payments migration.",
      tags: ["migration", "payments"],
    });
    expect(id).toBeTruthy();
    const found = episodes.searchFTS([{ scopeType: "conversation", scopeId: "c1" }], "payments", 5);
    expect(found).toHaveLength(1);
    expect(JSON.parse(found[0].tags)).toContain("payments");
  });

  it("searches across multiple scopes", () => {
    episodes.addEpisode({ scopeType: "user", scopeId: "u1", summary: "Alice joined the platform team." });
    const found = episodes.searchFTS([
      { scopeType: "conversation", scopeId: "c1" },
      { scopeType: "user", scopeId: "u1" },
    ], "joined OR migration", 10);
    expect(found.length).toBeGreaterThanOrEqual(2);
  });

  it("enforces the per-scope cap by dropping the oldest", () => {
    for (let i = 0; i < episodes.MAX_EPISODES_PER_SCOPE + 10; i++) {
      episodes.addEpisode({ scopeType: "conversation", scopeId: "capped", summary: `event number ${i}` });
    }
    const all = episodes.searchFTS([{ scopeType: "conversation", scopeId: "capped" }], "event", 500);
    expect(all.length).toBeLessThanOrEqual(episodes.MAX_EPISODES_PER_SCOPE);
  });

  it("only returns unembedded rows from getByIds", () => {
    const id = episodes.addEpisode({ scopeType: "user", scopeId: "u9", summary: "Needs an embedding." });
    expect(episodes.getByIds([id])).toHaveLength(1);
    episodes.setEmbedding(id, new Float32Array([1, 0, 0]));
    expect(episodes.getByIds([id])).toHaveLength(0);
  });
});

describe("participants", () => {
  it("registers a newly seen participant", () => {
    const { participants, renames } = applyParticipantUpdate({}, [{ userId: "u1", displayName: "Alice" }]);
    expect(participants.u1.currentName).toBe("Alice");
    expect(participants.u1.namesSeen).toEqual(["Alice"]);
    expect(renames).toHaveLength(0);
  });

  it("records a rename and preserves the former name", () => {
    const first = applyParticipantUpdate({}, [{ userId: "u1", displayName: "Alice" }]).participants;
    const { participants, renames } = applyParticipantUpdate(first, [{ userId: "u1", displayName: "Alicia" }]);
    expect(renames).toEqual([{ userId: "u1", oldName: "Alice", newName: "Alicia" }]);
    expect(participants.u1.namesSeen).toEqual(["Alice", "Alicia"]);
  });

  it("expires participants idle past the TTL", () => {
    const stale = { u1: { currentName: "Ghost", namesSeen: ["Ghost"], firstSeen: 0, lastSeen: 0 } };
    const { participants } = applyParticipantUpdate(stale, [{ userId: "u2", displayName: "Bob" }]);
    expect(participants.u1).toBeUndefined();
    expect(participants.u2).toBeDefined();
  });

  it("renders a roster listing former names", () => {
    const participants = {
      u1: { currentName: "Alicia", namesSeen: ["Alice", "Alicia"] },
      u2: { currentName: "Bob", namesSeen: ["Bob"] },
    };
    const block = buildParticipantsBlock(participants, ["u1", "u2"]);
    expect(block).toContain("Alicia (user_u1) (aka Alice)");
    expect(block).toContain("Bob (user_u2)");
  });

  it("returns an empty roster when nobody present is known", () => {
    expect(buildParticipantsBlock({}, ["unknown"])).toBe("");
  });
});
