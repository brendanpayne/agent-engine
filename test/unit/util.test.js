const { isSafeUrl } = require("../../src/util/ssrf");
const { splitAtWordBoundary } = require("../../src/util/textSplit");
const { withLock } = require("../../src/util/lock");
const { estimateTokenCount, estimateCost } = require("../../src/llm/cost");
const { isTransientError, withTimeout, retryWithBackoff } = require("../../src/llm/retry");

describe("isSafeUrl", () => {
  it("allows ordinary public URLs", () => {
    expect(isSafeUrl("https://example.com/page").safe).toBe(true);
  });

  it.each([
    ["ftp://example.com/x", "protocol"],
    ["http://localhost/x", "localhost"],
    ["http://127.0.0.1/x", "loopback"],
    ["http://10.1.2.3/x", "private"],
    ["http://192.168.1.1/x", "private"],
    ["http://172.16.0.1/x", "private"],
    ["http://169.254.169.254/latest/meta-data", "metadata"],
    ["http://metadata.google.internal/x", "metadata"],
    ["http://something.internal/x", "internal hostname"],
    ["http://100.64.0.1/x", "carrier-grade NAT"],
    ["http://192.0.2.5/x", "documentation range"],
    ["http://[::1]/x", "ipv6 loopback"],
    ["http://[fe80::1]/x", "ipv6 link-local"],
    ["http://[fc00::1]/x", "ipv6 unique-local"],
    ["not-a-url", "malformed"],
  ])("blocks %s (%s)", (url) => {
    expect(isSafeUrl(url).safe).toBe(false);
  });

  it("gives a reason for every rejection", () => {
    const result = isSafeUrl("http://10.0.0.1/");
    expect(result.safe).toBe(false);
    expect(typeof result.reason).toBe("string");
    expect(result.reason.length).toBeGreaterThan(0);
  });
});

describe("splitAtWordBoundary", () => {
  it("returns short text as a single chunk", () => {
    expect(splitAtWordBoundary("hello world", 100)).toEqual(["hello world"]);
  });

  it("returns the whole string when no limit is given", () => {
    expect(splitAtWordBoundary("hello world")).toEqual(["hello world"]);
  });

  it("splits on spaces and respects the limit", () => {
    const chunks = splitAtWordBoundary("aaa bbb ccc ddd eee fff", 10);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(10);
    expect(chunks.join(" ")).toBe("aaa bbb ccc ddd eee fff");
  });

  it("hard-splits a word longer than the limit", () => {
    const chunks = splitAtWordBoundary("x".repeat(25), 10);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("handles empty input", () => {
    expect(splitAtWordBoundary("", 10)).toEqual([]);
  });
});

describe("withLock", () => {
  it("serializes work sharing a key", async () => {
    const order = [];
    const slow = async (tag, ms) => withLock("same", async () => {
      order.push(`${tag}-start`);
      await new Promise(r => setTimeout(r, ms));
      order.push(`${tag}-end`);
    });
    await Promise.all([slow("a", 20), slow("b", 1)]);
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("does not serialize across different keys", async () => {
    const active = { count: 0, max: 0 };
    const task = key => withLock(key, async () => {
      active.count++;
      active.max = Math.max(active.max, active.count);
      await new Promise(r => setTimeout(r, 10));
      active.count--;
    });
    await Promise.all([task("k1"), task("k2")]);
    expect(active.max).toBe(2);
  });

  it("releases the lock when the callback throws", async () => {
    await expect(withLock("boom", async () => { throw new Error("x"); })).rejects.toThrow("x");
    await expect(withLock("boom", async () => "recovered")).resolves.toBe("recovered");
  });
});

describe("cost estimation", () => {
  it("returns zero tokens for empty input", () => {
    expect(estimateTokenCount("")).toBe(0);
  });

  it("scales roughly with length", () => {
    expect(estimateTokenCount("hello world this is a test")).toBeGreaterThan(0);
    expect(estimateTokenCount("a".repeat(350))).toBeGreaterThan(estimateTokenCount("a".repeat(35)));
  });

  it("prices a cache hit below a cache miss", () => {
    const hit = Number(estimateCost({ usage: { prompt_cache_hit_tokens: 1_000_000 } }));
    const miss = Number(estimateCost({ usage: { prompt_cache_miss_tokens: 1_000_000 } }));
    expect(hit).toBeLessThan(miss);
  });

  it("treats prompt tokens as a miss when no cache split is reported", () => {
    expect(Number(estimateCost({ usage: { prompt_tokens: 1_000_000 } }))).toBeGreaterThan(0);
  });
});

describe("retry helpers", () => {
  it("classifies transient failures", () => {
    expect(isTransientError({ code: "ECONNRESET" })).toBe(true);
    expect(isTransientError({ response: { status: 503 } })).toBe(true);
    expect(isTransientError({ response: { status: 429 } })).toBe(true);
    expect(isTransientError({ response: { status: 400 } })).toBe(false);
    expect(isTransientError(null)).toBe(false);
  });

  it("rejects when a promise exceeds the timeout", async () => {
    const slow = new Promise(r => setTimeout(r, 200));
    await expect(withTimeout(slow, 10, "too slow")).rejects.toThrow("too slow");
  });

  it("resolves within the timeout", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 100)).resolves.toBe("ok");
  });

  it("retries a transient failure and then succeeds", async () => {
    let attempts = 0;
    const result = await retryWithBackoff(async () => {
      if (++attempts < 3) throw { code: "ECONNRESET", message: "reset" };
      return "done";
    }, 3, 1);
    expect(result).toBe("done");
    expect(attempts).toBe(3);
  });

  it("does not retry a non-transient failure", async () => {
    let attempts = 0;
    await expect(retryWithBackoff(async () => {
      attempts++;
      throw { response: { status: 400 }, message: "bad request" };
    }, 3, 1)).rejects.toBeTruthy();
    expect(attempts).toBe(1);
  });
});
