const path = require("path");
process.env.MEMORY_TEST_DB = path.join(__dirname, "../tmp/loop-test.sqlite");

const {
  accumulateToolCalls, parseInlineToolCalls, presentMemberIds,
  trimToTokenBudget, pruneDanglingToolMessages, applyGuards,
} = require("../../src/agent/loop");

describe("accumulateToolCalls", () => {
  it("assembles a tool call from streamed deltas", () => {
    let acc = accumulateToolCalls(null, [{ index: 0, id: "c1", function: { name: "web_search" } }]);
    acc = accumulateToolCalls(acc, [{ index: 0, function: { arguments: "{\"query\":" } }]);
    acc = accumulateToolCalls(acc, [{ index: 0, function: { arguments: "\"hi\"}" } }]);
    expect(acc).toHaveLength(1);
    expect(acc[0].id).toBe("c1");
    expect(acc[0].function.name).toBe("web_search");
    expect(JSON.parse(acc[0].function.arguments)).toEqual({ query: "hi" });
  });

  it("keeps parallel tool calls separate by index", () => {
    const acc = accumulateToolCalls(null, [
      { index: 0, id: "a", function: { name: "one", arguments: "{}" } },
      { index: 1, id: "b", function: { name: "two", arguments: "{}" } },
    ]);
    expect(acc.map(c => c.function.name)).toEqual(["one", "two"]);
  });
});

describe("parseInlineToolCalls", () => {
  it("returns nothing for ordinary prose", () => {
    expect(parseInlineToolCalls("Just a normal reply.")).toEqual([]);
    expect(parseInlineToolCalls(null)).toEqual([]);
  });

  it("recovers a tool call emitted as inline markup", () => {
    const content =
      "<|DSML|invoke name=\"web_search\">" +
      "<|DSML|parameter name=\"query\" string=\"true\">weather</|DSML|parameter>" +
      "</|DSML|invoke>";
    const calls = parseInlineToolCalls(content);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("web_search");
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ query: "weather" });
  });
});

describe("presentMemberIds", () => {
  it("puts the speaker first and de-duplicates, excluding the agent", () => {
    const ids = presentMemberIds({ userId: "u1" }, [
      { userId: "u2", isAgent: false },
      { userId: "agent", isAgent: true },
      { userId: "u1", isAgent: false },
      { userId: "u2", isAgent: false },
    ]);
    expect(ids).toEqual(["u1", "u2"]);
  });

  it("handles an empty history", () => {
    expect(presentMemberIds({ userId: "u1" }, [])).toEqual(["u1"]);
  });
});

describe("trimToTokenBudget", () => {
  it("leaves a small history untouched", () => {
    const history = [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }];
    expect(trimToTokenBudget("sys", history, "now what?")).toHaveLength(2);
  });

  it("drops the oldest turns but never below the floor", () => {
    const huge = "word ".repeat(20000);
    const history = Array.from({ length: 20 }, () => ({ role: "user", content: huge }));
    const trimmed = trimToTokenBudget("sys", history, "q");
    expect(trimmed.length).toBeLessThan(20);
    expect(trimmed.length).toBeGreaterThanOrEqual(4);
  });
});

describe("pruneDanglingToolMessages", () => {
  const assistantCall = (...ids) => ({
    role: "assistant", content: null, tool_calls: ids.map(id => ({ id, function: { name: "t" } })),
  });
  const toolReply = id => ({ role: "tool", tool_call_id: id, content: "{}" });

  it("leaves a well-paired history untouched", () => {
    const history = [
      { role: "user", content: "hi" },
      assistantCall("c1"),
      toolReply("c1"),
      { role: "assistant", content: "done" },
    ];
    expect(pruneDanglingToolMessages(history)).toEqual(history);
  });

  it("drops a tool reply whose call was trimmed away", () => {
    const out = pruneDanglingToolMessages([toolReply("c1"), { role: "assistant", content: "done" }]);
    expect(out).toEqual([{ role: "assistant", content: "done" }]);
  });

  it("drops an assistant tool_calls message whose replies were trimmed away", () => {
    const out = pruneDanglingToolMessages([assistantCall("c1"), { role: "user", content: "next" }]);
    expect(out).toEqual([{ role: "user", content: "next" }]);
  });

  it("drops a partially answered call and the reply that survived with it", () => {
    // c2's reply was cut, so the assistant message goes — which orphans c1's
    // reply, and the fixpoint loop has to remove that on a second pass.
    const out = pruneDanglingToolMessages([assistantCall("c1", "c2"), toolReply("c1")]);
    expect(out).toEqual([]);
  });

  it("handles an empty history", () => {
    expect(pruneDanglingToolMessages([])).toEqual([]);
  });
});

describe("applyGuards", () => {
  const base = { toolResults: [], userText: "", hasAttachments: false };

  it("strips hallucinated attachment markup", () => {
    expect(applyGuards("Here you go [Attached: image.png]", base)).toBe("Here you go");
  });

  it("strips URLs when no web tool ran", () => {
    const out = applyGuards("See https://made-up.example/page for details.", base);
    expect(out).not.toContain("made-up.example");
  });

  it("keeps URLs when a web tool ran this turn", () => {
    const out = applyGuards("See https://real.example/page.", {
      ...base, toolResults: [{ tool: "web_search" }],
    });
    expect(out).toContain("https://real.example/page");
  });

  it("keeps a URL the user themselves supplied", () => {
    const url = "https://user-supplied.example/x";
    const out = applyGuards(`About ${url} — here's what I think.`, { ...base, userText: `check ${url}` });
    expect(out).toContain(url);
  });

  it("strips leaked provider markup", () => {
    const out = applyGuards("text <|DSML|invoke name=\"x\">y</|DSML|invoke> more", base);
    expect(out).not.toContain("DSML");
  });

  it("passes clean text through unchanged", () => {
    expect(applyGuards("A perfectly normal reply.", base)).toBe("A perfectly normal reply.");
  });

  it("returns the input unchanged when there is no response", () => {
    expect(applyGuards(null, base)).toBeNull();
  });
});
