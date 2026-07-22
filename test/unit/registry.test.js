const { ToolRegistry, executeToolCall, normalizeArgs } = require("../../src/agent/tools/registry");

function call(name, args) {
  return { id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function newCtx() {
  return { input: { userId: "u1", conversationId: "c1" }, attachments: [], queryCache: new Map() };
}

describe("ToolRegistry", () => {
  it("registers tools and exposes provider-shaped definitions", () => {
    const registry = new ToolRegistry().register({
      name: "ping",
      description: "Ping.",
      parameters: { type: "object", properties: {}, required: [] },
      handler: async () => ({ pong: true }),
    });
    expect(registry.has("ping")).toBe(true);
    expect(registry.size()).toBe(1);
    const [def] = registry.definitions();
    expect(def.type).toBe("function");
    expect(def.function.name).toBe("ping");
  });

  it("rejects a tool with no handler", () => {
    expect(() => new ToolRegistry().register({ name: "bad" })).toThrow(/handler/);
  });

  it("tracks side-effect tools", () => {
    const registry = new ToolRegistry().register({
      name: "act", handler: async () => ({}), sideEffect: true,
    });
    expect(registry.isSideEffect("act")).toBe(true);
  });
});

describe("normalizeArgs", () => {
  it("collapses word order, case, and punctuation to one cache key", () => {
    expect(normalizeArgs({ query: "who wrote the docs?" }))
      .toBe(normalizeArgs({ query: "The DOCS — wrote who!" }));
  });

  it("keeps genuinely different queries distinct", () => {
    expect(normalizeArgs({ query: "who wrote the docs" }))
      .not.toBe(normalizeArgs({ query: "who reviewed the docs" }));
  });

  it("is order-insensitive across object keys", () => {
    expect(normalizeArgs({ a: 1, b: 2 })).toBe(normalizeArgs({ b: 2, a: 1 }));
  });
});

describe("executeToolCall", () => {
  it("runs a registered tool", async () => {
    const registry = new ToolRegistry().register({
      name: "echo", handler: async args => ({ said: args.text }),
    });
    const result = await executeToolCall(registry, call("echo", { text: "hi" }), newCtx());
    expect(result).toEqual({ said: "hi" });
  });

  it("returns an error object for an unknown tool", async () => {
    const result = await executeToolCall(new ToolRegistry(), call("nope", {}), newCtx());
    expect(result.error).toMatch(/Unknown tool/);
  });

  it("returns invalid_arguments instead of throwing on a schema violation", async () => {
    const registry = new ToolRegistry().register({ name: "web_search", handler: async () => ({}) });
    const result = await executeToolCall(registry, call("web_search", { count: 2 }), newCtx());
    expect(result.error).toBe("invalid_arguments");
    expect(result.details).toMatch(/query/);
  });

  it("returns invalid_arguments for unparseable argument JSON", async () => {
    const registry = new ToolRegistry().register({ name: "echo", handler: async () => ({}) });
    const bad = { id: "c1", type: "function", function: { name: "echo", arguments: "{not json" } };
    const result = await executeToolCall(registry, bad, newCtx());
    expect(result.error).toBe("invalid_arguments");
  });

  it("converts a thrown handler error into a tool result", async () => {
    const registry = new ToolRegistry().register({
      name: "boom", handler: async () => { throw new Error("kaboom"); },
    });
    const result = await executeToolCall(registry, call("boom", {}), newCtx());
    expect(result.error).toBe("kaboom");
  });

  it("deduplicates repeated read-only calls within a turn", async () => {
    let calls = 0;
    const registry = new ToolRegistry().register({
      name: "lookup", handler: async () => { calls++; return { n: calls }; },
    });
    const ctx = newCtx();
    await executeToolCall(registry, call("lookup", { q: "same thing" }), ctx);
    const second = await executeToolCall(registry, call("lookup", { q: "SAME thing!" }), ctx);
    expect(calls).toBe(1);
    expect(second.note).toMatch(/Duplicate query/);
  });

  it("never deduplicates side-effect tools", async () => {
    let calls = 0;
    const registry = new ToolRegistry().register({
      name: "act", sideEffect: true, handler: async () => { calls++; return { n: calls }; },
    });
    const ctx = newCtx();
    await executeToolCall(registry, call("act", { x: 1 }), ctx);
    await executeToolCall(registry, call("act", { x: 1 }), ctx);
    expect(calls).toBe(2);
  });
});
