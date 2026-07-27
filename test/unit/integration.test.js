// Full-turn integration test with a stubbed provider.
//
// This is the test that proves the decoupling claim: a complete turn — context
// assembly, tool dispatch, output guards, citation expansion, memory writes —
// driven entirely by a plain { userId, conversationId, text } object, with no
// platform SDK anywhere in the stack.

const path = require("path");
const fs = require("fs");

const TMP = path.join(__dirname, "../tmp-integration");
fs.mkdirSync(TMP, { recursive: true });
process.env.MEMORY_TEST_DB = path.join(TMP, "memory.sqlite");
process.env.ARCHIVE_TEST_DB = path.join(TMP, "archive.sqlite");
process.env.EPISODES_TEST_DB = path.join(TMP, "episodes.sqlite");
process.env.KB_TEST_DB = path.join(TMP, "kb.sqlite");
process.env.LOG_TO_FILE = "false";

// Scripted provider. Each test sets `mockResponses` to the sequence of completions
// the loop should receive.
let mockResponses = [];
let mockChatCalls = [];

jest.mock("../../src/llm", () => ({
  chat: jest.fn(async (args) => {
    mockChatCalls.push(args);
    const next = mockResponses.shift();
    if (!next) throw new Error("Stub ran out of scripted responses");
    return {
      result: next,
      usage: { total_tokens: 100, cost_usd: "0.000042" },
      raw: {},
    };
  }),
  chatStream: jest.fn(),
  embed: jest.fn(async () => ({ embedding: new Float32Array([1, 0, 0]) })),
  generateImage: jest.fn(async () => ({ buffer: Buffer.from("png"), mimeType: "image/png" })),
  describeImage: jest.fn(),
  estimateTokenCount: t => Math.ceil((t || "").length / 3.5),
  estimateCost: () => "0",
  closeEmbedCache: jest.fn(),
  getCacheStats: () => ({}),
}));

const engine = require("../../index.js");
const memoryStore = require("../../src/memory/store");

function toolCall(name, args, id = "t1") {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function baseInput(overrides = {}) {
  return {
    userId: "alice",
    userName: "Alice",
    conversationId: `conv-${Math.random().toString(36).slice(2)}`,
    scopeId: "demo",
    text: "is the api up?",
    messageId: `m-${Date.now()}`,
    timestamp: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  mockResponses = [];
  mockChatCalls = [];
});

afterAll(() => {
  engine.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("a complete agent turn", () => {
  it("answers a plain question with no tools", async () => {
    mockResponses = [{ content: "Yes, everything looks fine.", finish_reason: "stop" }];

    const result = await engine.run(baseInput(), { updateMemory: false });

    expect(result.error).toBeUndefined();
    expect(result.text).toBe("Yes, everything looks fine.");
    expect(result.toolCalls).toHaveLength(0);
    expect(result.usage.total_tokens).toBe(100);
  });

  it("dispatches a tool call and synthesizes from the result", async () => {
    mockResponses = [
      { content: null, finish_reason: "tool_calls", tool_calls: [toolCall("get_status", { service: "api" })] },
      { content: "The api service is healthy.", finish_reason: "stop" },
    ];

    let receivedArgs = null;
    let receivedCtx = null;
    const registry = new engine.ToolRegistry().register({
      name: "get_status",
      description: "Get service health.",
      parameters: { type: "object", properties: { service: { type: "string" } }, required: ["service"] },
      handler: async (args, ctx) => {
        receivedArgs = args;
        receivedCtx = ctx;
        return { service: args.service, healthy: true };
      },
    });

    const result = await engine.run(baseInput(), { registry, updateMemory: false });

    expect(receivedArgs).toEqual({ service: "api" });
    // The handler sees the normalized input, never a platform object.
    expect(receivedCtx.input.userId).toBe("alice");
    expect(result.toolCalls.map(t => t.tool)).toEqual(["get_status"]);
    expect(result.text).toBe("The api service is healthy.");

    // Second call carries the assistant tool_calls turn plus the tool result.
    const secondCall = mockChatCalls[1];
    const roles = secondCall.messages.map(m => m.role);
    expect(roles).toContain("tool");
  });

  it("builds a system prompt carrying identity rules and the participant roster", async () => {
    mockResponses = [{ content: "ok", finish_reason: "stop" }];

    await engine.run(
      baseInput({ participants: [{ id: "bob", name: "Bob" }] }),
      {
        history: [{ userId: "bob", userName: "Bob", text: "anyone there?", messageId: "m0", timestamp: Date.now() - 1000, isAgent: false }],
        updateMemory: false,
      },
    );

    const systemPrompt = mockChatCalls[0].messages[0].content;
    expect(systemPrompt).toContain("[Identity Rules]");
    expect(systemPrompt).toContain("[Participants]");
    expect(systemPrompt).toContain("Alice (user_alice)");
    expect(systemPrompt).toContain("Bob (user_bob)");
    // The volatile tail must come last, or the provider prompt cache breaks.
    expect(systemPrompt.indexOf("[Identity Rules]")).toBeLessThan(systemPrompt.indexOf("You are currently speaking to"));
  });

  it("prefixes history turns with the stable user id anchor", async () => {
    mockResponses = [{ content: "ok", finish_reason: "stop" }];

    await engine.run(baseInput(), {
      history: [{ userId: "bob", userName: "Bob", text: "hello", messageId: "m0", timestamp: Date.now(), isAgent: false }],
      updateMemory: false,
    });

    const messages = mockChatCalls[0].messages;
    expect(messages.find(m => m.role === "user" && m.content.includes("[user_bob] Bob: hello"))).toBeTruthy();
    expect(messages[messages.length - 1].content).toContain("[user_alice] Alice: is the api up?");
  });

  it("returns invalid_arguments to the model and lets it recover", async () => {
    mockResponses = [
      { content: null, finish_reason: "tool_calls", tool_calls: [toolCall("web_search", { count: 3 })] },
      { content: "Recovered without the search.", finish_reason: "stop" },
    ];

    const result = await engine.run(baseInput(), { updateMemory: false });

    expect(result.toolCalls[0].result.error).toBe("invalid_arguments");
    expect(result.text).toBe("Recovered without the search.");
  });

  it("keeps going when a tool handler throws", async () => {
    mockResponses = [
      { content: null, finish_reason: "tool_calls", tool_calls: [toolCall("boom", {})] },
      { content: "That lookup failed, but here's what I know.", finish_reason: "stop" },
    ];

    const registry = new engine.ToolRegistry().register({
      name: "boom", handler: async () => { throw new Error("upstream exploded"); },
    });

    const result = await engine.run(baseInput(), { registry, updateMemory: false });
    expect(result.toolCalls[0].result.error).toBe("upstream exploded");
    expect(result.text).toContain("here's what I know");
  });

  it("stops calling tools at the depth limit and forces a synthesis", async () => {
    const registry = new engine.ToolRegistry().register({
      name: "loop_forever", handler: async () => ({ more: "data" }),
    });

    // Every response asks for another tool call; the loop must break out.
    mockResponses = Array.from({ length: 6 }, () => ({
      content: null, finish_reason: "tool_calls", tool_calls: [toolCall("loop_forever", {})],
    }));
    mockResponses.push({ content: "Synthesized from what I gathered.", finish_reason: "stop" });

    const result = await engine.run(baseInput(), { registry, maxToolDepth: 3, updateMemory: false });

    expect(result.toolCalls.length).toBeLessThanOrEqual(3);
    expect(result.text).toBeTruthy();
    // The final slot must be sent without tools, or the model just calls again.
    expect(mockChatCalls[mockChatCalls.length - 1].tools).toBeUndefined();
  });

  it("expands a citation the retrieval tool actually returned", async () => {
    mockResponses = [
      { content: null, finish_reason: "tool_calls", tool_calls: [toolCall("search_history", { query: "deploy" })] },
      { content: "Bob mentioned it [[cite:msg:1]].", finish_reason: "stop" },
    ];

    const registry = new engine.ToolRegistry().register({
      name: "search_history",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      handler: async () => ({ results: [{ result_index: 1, message_id: "m-42", content: "we deployed" }] }),
    });

    const result = await engine.run(baseInput(), {
      registry,
      updateMemory: false,
      citationFormatters: { msg: ({ messageId }) => `(src:${messageId})` },
    });

    expect(result.text).toBe("Bob mentioned it (src:m-42).");
  });

  it("strips a citation index that was never retrieved", async () => {
    mockResponses = [{ content: "Definitely true [[cite:msg:7]].", finish_reason: "stop" }];
    const result = await engine.run(baseInput(), { updateMemory: false });
    expect(result.text).not.toContain("cite:msg");
    expect(result.text).toContain("Definitely true");
  });

  it("strips a URL invented without a web tool", async () => {
    mockResponses = [{ content: "Read more at https://invented.example/docs today.", finish_reason: "stop" }];
    const result = await engine.run(baseInput(), { updateMemory: false });
    expect(result.text).not.toContain("invented.example");
  });

  it("attaches a generated image without putting it in the transcript", async () => {
    mockResponses = [
      { content: null, finish_reason: "tool_calls", tool_calls: [toolCall("generate_image", { prompt: "a cat" })] },
      { content: "Here it is.", finish_reason: "stop" },
    ];

    const result = await engine.run(baseInput({ text: "draw me a cat" }), { updateMemory: false });

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].filename).toBe("generated.png");
    expect(result.attachments[0].buffer).toBeInstanceOf(Buffer);
    // The binary must not be echoed back into the message array.
    const toolMessage = mockChatCalls[1].messages.find(m => m.role === "tool");
    expect(toolMessage.content).not.toContain("buffer");
  });

  it("falls back to a reply rather than returning silence", async () => {
    mockResponses = [{ content: "", finish_reason: "stop" }];
    const result = await engine.run(baseInput(), { updateMemory: false });
    expect(result.text).toBeTruthy();
  });

  it("returns a structured error instead of throwing when the provider fails", async () => {
    mockResponses = [];  // stub throws
    const result = await engine.run(baseInput(), { updateMemory: false });
    expect(result.error).toBeTruthy();
    expect(result.text).toBeNull();
  });

  it("rejects input missing the required identifiers", async () => {
    await expect(engine.run({ text: "hi" })).rejects.toThrow(/userId and conversationId/);
  });
});

describe("memory writes during a turn", () => {
  it("records participants and advances the counters", async () => {
    mockResponses = [{ content: "ok", finish_reason: "stop" }];
    const input = baseInput({ conversationId: "conv-memory", participants: [{ id: "bob", name: "Bob" }] });

    await engine.run(input, { updateMemory: true });
    await new Promise(r => setTimeout(r, 150));

    const ctx = memoryStore.getConversation("conv-memory");
    expect(ctx.participants.alice.currentName).toBe("Alice");
    expect(ctx.participants.bob.currentName).toBe("Bob");
    expect(ctx.messagesSinceSummary).toBeGreaterThan(0);
  });

  it("surfaces stored facts in the next turn's prompt", async () => {
    await memoryStore.updateUser("carol", {
      facts: [{ key: "job", value: "site reliability engineer", confidence: "high", reinforcedCount: 3, updatedAt: Date.now() }],
    });

    mockResponses = [{ content: "ok", finish_reason: "stop" }];
    await engine.run(baseInput({ userId: "carol", userName: "Carol", conversationId: "conv-facts" }), { updateMemory: false });

    const systemPrompt = mockChatCalls[0].messages[0].content;
    expect(systemPrompt).toContain("job: site reliability engineer");
    expect(systemPrompt).toContain("id=\"carol\"");
  });

  it("keeps an incognito user's facts out of the prompt", async () => {
    await memoryStore.updateUser("dave", {
      facts: [{ key: "secret", value: "classified detail", confidence: "high", reinforcedCount: 3, updatedAt: Date.now() }],
    });
    await memoryStore.updateUser("dave", { incognito: true });

    mockResponses = [{ content: "ok", finish_reason: "stop" }];
    await engine.run(baseInput({ userId: "dave", userName: "Dave", conversationId: "conv-incognito" }), { updateMemory: false });

    expect(mockChatCalls[0].messages[0].content).not.toContain("classified detail");
  });
});

describe("standing directives", () => {
  it("carries stored directives into the prompt, above the volatile tail", async () => {
    const { mergeDirectives } = require("../../src/memory/directives");
    const { directives } = mergeDirectives([], ["Never reveal puzzle answers; give hints instead"]);
    await memoryStore.updateConversation("conv-directives", { directives });

    mockResponses = [{ content: "ok", finish_reason: "stop" }];
    await engine.run(baseInput({ conversationId: "conv-directives" }), { updateMemory: false });

    const systemPrompt = mockChatCalls[0].messages[0].content;
    expect(systemPrompt).toContain("[Standing Instructions]");
    expect(systemPrompt).toContain("Never reveal puzzle answers");
    expect(systemPrompt.indexOf("[Standing Instructions]"))
      .toBeLessThan(systemPrompt.indexOf("Current time:"));
  });

  it("persists a directive the model sets through the tool", async () => {
    mockResponses = [
      {
        content: null,
        finish_reason: "tool_calls",
        tool_calls: [toolCall("set_directive", { instruction: "Keep replies under three sentences" })],
      },
      { content: "Got it — short replies from now on.", finish_reason: "stop" },
    ];

    const result = await engine.run(
      baseInput({ conversationId: "conv-set-directive", text: "from now on keep replies under three sentences" }),
      { updateMemory: false },
    );

    expect(result.toolCalls.map(t => t.tool)).toEqual(["set_directive"]);
    const stored = memoryStore.getConversation("conv-set-directive").directives;
    expect(stored).toHaveLength(1);
    expect(stored[0].text).toBe("Keep replies under three sentences");
    expect(stored[0].source).toBe("tool");
    expect(stored[0].createdBy).toBe("alice");
  });

  it("retracts a directive through the tool, matching on wording", async () => {
    const { mergeDirectives } = require("../../src/memory/directives");
    const { directives } = mergeDirectives([], ["Never discuss spoilers for the finale"]);
    await memoryStore.updateConversation("conv-remove-directive", { directives });

    mockResponses = [
      {
        content: null,
        finish_reason: "tool_calls",
        tool_calls: [toolCall("remove_directive", { directive: "spoilers" })],
      },
      { content: "Understood, spoilers are back on the table.", finish_reason: "stop" },
    ];

    await engine.run(baseInput({ conversationId: "conv-remove-directive" }), { updateMemory: false });

    expect(memoryStore.getConversation("conv-remove-directive").directives).toHaveLength(0);
  });
});

describe("knowledge-base pre-flight", () => {
  const kbStore = require("../../src/kb/store");

  beforeAll(async () => {
    await kbStore.create({
      scopeId: "demo",
      slug: "oncall-rotation",
      title: "Oncall Rotation",
      content: "The oncall rotation hands over every Tuesday at 10:00 UTC.",
      tags: "operations",
      creatorId: "admin",
    });
  });

  it("injects a matching entry without the model spending a lookup_kb call", async () => {
    mockResponses = [{ content: "Tuesdays at 10:00 UTC.", finish_reason: "stop" }];

    const result = await engine.run(
      baseInput({ text: "when does the oncall rotation hand over?" }),
      { updateMemory: false },
    );

    const systemPrompt = mockChatCalls[0].messages[0].content;
    expect(systemPrompt).toContain("[KnowledgeBase]");
    expect(systemPrompt).toContain("[[kb:oncall-rotation]]");
    expect(result.toolCalls).toHaveLength(0);
  });

  it("makes a pre-flight entry citable even though no tool returned it", async () => {
    mockResponses = [{ content: "Tuesdays [[cite:kb:oncall-rotation]].", finish_reason: "stop" }];

    const result = await engine.run(
      baseInput({ text: "when does the oncall rotation hand over?" }),
      { updateMemory: false, citationFormatters: { kb: ({ slug }) => `(kb:${slug})` } },
    );

    expect(result.text).toBe("Tuesdays (kb:oncall-rotation).");
  });

  it("stays out of the prompt when nothing matches", async () => {
    mockResponses = [{ content: "ok", finish_reason: "stop" }];
    await engine.run(baseInput({ text: "what should I have for lunch" }), { updateMemory: false });
    // Not "[KnowledgeBase]" — the tool block names the section unconditionally.
    // The injected entries themselves are what must be absent.
    expect(mockChatCalls[0].messages[0].content).not.toContain("[[kb:");
  });
});
