const path = require("path");
const fs = require("fs");

const TEST_DB = path.join(__dirname, "../tmp/kb-preflight-test.sqlite");
process.env.KB_TEST_DB = TEST_DB;

const kbStore = require("../../src/kb/store");
const preflight = require("../../src/kb/preflight");

const SCOPE = "scope-1";

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = `${TEST_DB}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  await kbStore.create({
    scopeId: SCOPE,
    slug: "refund-policy",
    title: "Refund Policy",
    content: "Refunds are issued within fourteen days of purchase. Contact billing to start one.",
    tags: "billing, payments",
    creatorId: "admin",
  });
  await kbStore.create({
    scopeId: SCOPE,
    slug: "deploy-runbook",
    title: "Deploy Runbook",
    content: "Deployments run from the release branch. Roll back with the previous artifact tag.",
    tags: "operations, release",
    creatorId: "admin",
  });
  await kbStore.create({
    scopeId: SCOPE,
    slug: "onboarding",
    title: "Onboarding Checklist",
    content: "New hires get accounts on day one and a mentor on day two.",
    tags: "people",
    creatorId: "admin",
  });
});

afterAll(() => {
  kbStore.close();
});

beforeEach(() => {
  preflight.invalidate();
});

describe("findRelevant", () => {
  it("surfaces the entry whose title matches the turn", () => {
    const matches = preflight.findRelevant(SCOPE, "how does the refund policy work?");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].slug).toBe("refund-policy");
    expect(matches[0].score).toBeGreaterThan(0.25);
  });

  it("matches on tags as well as titles", () => {
    const matches = preflight.findRelevant(SCOPE, "anything about billing I should know");
    expect(matches.map(m => m.slug)).toContain("refund-policy");
  });

  it("matches on body content", () => {
    const matches = preflight.findRelevant(SCOPE, "which branch do deployments run from");
    expect(matches[0].slug).toBe("deploy-runbook");
  });

  it("returns nothing for an unrelated turn", () => {
    expect(preflight.findRelevant(SCOPE, "what should I have for lunch today")).toEqual([]);
  });

  it("returns nothing for a turn that is entirely stopwords", () => {
    expect(preflight.findRelevant(SCOPE, "what do you think about that")).toEqual([]);
  });

  it("respects the entry limit", () => {
    const matches = preflight.findRelevant(SCOPE, "refund policy deploy runbook onboarding checklist", 1);
    expect(matches).toHaveLength(1);
  });

  it("truncates long content", () => {
    const matches = preflight.findRelevant(SCOPE, "refund policy");
    expect(matches[0].content.length).toBeLessThanOrEqual(403);
  });

  it("returns nothing without a scope or text", () => {
    expect(preflight.findRelevant(null, "refund policy")).toEqual([]);
    expect(preflight.findRelevant(SCOPE, "")).toEqual([]);
  });

  it("returns nothing for a scope with no entries", () => {
    expect(preflight.findRelevant("empty-scope", "refund policy")).toEqual([]);
  });

  it("does not let a long message dilute a real match", () => {
    const padded = "hey everyone hope the week is going alright, quick question — "
      + "how does the refund policy work if someone bought the wrong thing? "
      + "no rush, just curious, also the coffee machine is broken again";
    const matches = preflight.findRelevant(SCOPE, padded);
    expect(matches[0].slug).toBe("refund-policy");
  });
});

describe("index invalidation", () => {
  it("picks up a newly created entry", async () => {
    expect(preflight.findRelevant(SCOPE, "tell me about the incident postmortem")).toEqual([]);
    await kbStore.create({
      scopeId: SCOPE,
      slug: "incident-postmortem",
      title: "Incident Postmortem",
      content: "Every incident gets a written postmortem within five working days.",
      tags: "operations",
      creatorId: "admin",
    });
    const matches = preflight.findRelevant(SCOPE, "tell me about the incident postmortem");
    expect(matches[0].slug).toBe("incident-postmortem");
  });

  it("drops a deleted entry", () => {
    kbStore.deleteBySlug(SCOPE, "incident-postmortem");
    expect(preflight.findRelevant(SCOPE, "tell me about the incident postmortem")).toEqual([]);
  });
});

describe("buildKbContextBlock", () => {
  it("returns empty string for no matches", () => {
    expect(preflight.buildKbContextBlock([])).toBe("");
    expect(preflight.buildKbContextBlock(null)).toBe("");
  });

  it("renders slugs the model can cite", () => {
    const block = preflight.buildKbContextBlock(preflight.findRelevant(SCOPE, "refund policy"));
    expect(block).toContain("[KnowledgeBase]");
    expect(block).toContain("[[kb:refund-policy]] Refund Policy");
    expect(block).toContain("[[cite:kb:slug]]");
  });
});
