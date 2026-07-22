// Web access: search, then read.
//
// Split into two tools on purpose. Search returns cheap snippets so the model
// can judge relevance before committing tokens; fetch_page pulls the full text
// of one chosen result. A single combined tool would either return too little
// to answer with or too much to afford.

const { SEARCH_API_KEY } = require("../../../../config.js");
const logger = require("../../../util/logger");
const { fetchPageText } = require("../../../util/urlContext");

const SEARCH_ENDPOINT = process.env.SEARCH_ENDPOINT || "https://api.search.brave.com/res/v1/web/search";

const webSearch = {
  name: "web_search",
  description:
    "Search the web for current events, recent news, real-time facts, or anything outside your training data. " +
    "Returns a title, URL, and snippet per result. Follow up with fetch_page on a chosen URL to read the full page.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query." },
      count: { type: "integer", description: "Number of results to return (default 5, max 10)." },
    },
    required: ["query"],
  },
  async handler(args) {
    if (!SEARCH_API_KEY) return { error: "Web search is not configured (SEARCH_API_KEY is unset)." };

    const count = Math.min(Math.max(args.count || 5, 1), 10);
    const params = new URLSearchParams({
      q: args.query,
      count: String(count),
      result_filter: "web",
      safesearch: "strict",
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(`${SEARCH_ENDPOINT}?${params}`, {
        headers: {
          "Accept": "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": SEARCH_API_KEY,
        },
        signal: controller.signal,
      });
      if (!res.ok) return { error: `Search API returned HTTP ${res.status}.` };
      const data = await res.json();
      const results = (data.web?.results || []).map(r => ({
        title: r.title,
        url: r.url,
        description: r.description || "",
      }));
      if (results.length === 0) return { results: [], message: "No web results found." };
      return { results, query: args.query };
    } catch (err) {
      const reason = err.name === "AbortError" ? "Search timed out after 10s." : err.message;
      logger.error(`[web_search] ${reason}`);
      return { error: `Web search failed: ${reason}` };
    } finally {
      clearTimeout(timer);
    }
  },
};

const fetchPage = {
  name: "fetch_page",
  description:
    "Read the full text content of a specific URL — typically one returned by web_search, or one the user shared. " +
    "Returns the page title and extracted body text.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "The absolute http(s) URL to read." },
    },
    required: ["url"],
  },
  async handler(args) {
    // SSRF validation (including redirect targets) happens inside fetchPageText.
    const result = await fetchPageText(args.url, 4000);
    if (result.error) return { error: result.error };
    return { title: result.title, text: result.text, url: result.url };
  },
};

module.exports = { webSearch, fetchPage };
