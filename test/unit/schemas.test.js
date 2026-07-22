const { parseAndValidate, validateToolArgs, cleanMarkdownCode } = require("../../src/schemas");

describe("cleanMarkdownCode", () => {
  it("unwraps a fenced JSON block", () => {
    expect(cleanMarkdownCode("```json\n{\"ok\": true}\n```")).toBe("{\"ok\": true}");
  });

  it("extracts a JSON object from surrounding prose", () => {
    const raw = "Sure! Here you go: {\"ok\": true} Let me know if you need more.";
    expect(cleanMarkdownCode(raw)).toBe("{\"ok\": true}");
  });

  it("does not stop at a brace inside a string literal", () => {
    const raw = "prefix {\"fix\": \"use } carefully\"} suffix";
    expect(cleanMarkdownCode(raw)).toBe("{\"fix\": \"use } carefully\"}");
  });

  it("handles escaped quotes inside strings", () => {
    const raw = "{\"fix\": \"say \\\"hi\\\" politely\"}";
    expect(cleanMarkdownCode(raw)).toBe(raw);
  });

  it("extracts an array when it precedes any object", () => {
    expect(cleanMarkdownCode("noise [1, 2, 3] noise")).toBe("[1, 2, 3]");
  });

  it("returns the trimmed input when there is no JSON at all", () => {
    expect(cleanMarkdownCode("  no json here  ")).toBe("no json here");
  });
});

describe("parseAndValidate", () => {
  it("accepts a valid payload", () => {
    const { data, error } = parseAndValidate("critique", "{\"ok\": true}");
    expect(error).toBeNull();
    expect(data).toEqual({ ok: true });
  });

  it("accepts a valid payload wrapped in a code fence", () => {
    const { data, error } = parseAndValidate("critique", "```json\n{\"ok\": false, \"fix\": \"too vague\"}\n```");
    expect(error).toBeNull();
    expect(data.fix).toBe("too vague");
  });

  it("reports a parse error for malformed JSON", () => {
    const { data, error } = parseAndValidate("critique", "{ok: true");
    expect(data).toBeNull();
    expect(error).toMatch(/JSON parse error/);
  });

  it("reports a validation error for a wrong type", () => {
    const { data, error } = parseAndValidate("critique", "{\"ok\": \"yes\"}");
    expect(data).toBeNull();
    expect(error).toMatch(/Schema validation failed/);
  });

  it("rejects a payload missing a required property", () => {
    const { error } = parseAndValidate("fact-extraction", "{}");
    expect(error).toMatch(/Schema validation failed/);
  });

  it("accepts a well-formed fact-extraction payload", () => {
    const { data, error } = parseAndValidate(
      "fact-extraction",
      "{\"facts\": [{\"key\": \"job\", \"value\": \"nurse\", \"confidence\": \"high\"}]}",
    );
    expect(error).toBeNull();
    expect(data.facts[0].key).toBe("job");
  });
});

describe("validateToolArgs", () => {
  it("accepts valid arguments", () => {
    expect(validateToolArgs("web_search", { query: "hello" })).toEqual({ valid: true });
  });

  it("returns a structured failure rather than throwing", () => {
    const result = validateToolArgs("web_search", { count: 3 });
    expect(result.valid).toBe(false);
    expect(result.errors).toMatch(/query/);
  });

  it("rejects a value outside the allowed range", () => {
    const result = validateToolArgs("web_search", { query: "x", count: 99 });
    expect(result.valid).toBe(false);
  });

  it("rejects unknown properties", () => {
    const result = validateToolArgs("fetch_page", { url: "https://example.com", extra: 1 });
    expect(result.valid).toBe(false);
  });

  it("passes through tools that have no registered schema", () => {
    expect(validateToolArgs("some_host_tool", { anything: true })).toEqual({ valid: true });
  });
});
