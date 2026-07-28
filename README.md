# agent-engine

A standalone agentic LLM framework for Node.js: a provider-agnostic router, a
tiered memory system that compounds knowledge across conversations, structured
output validation with retry-on-failure, and a durable job queue — with a
fail-open reliability design throughout.

No framework lock-in, no vendor SDK in your application code, no platform
assumptions. The engine speaks one plain input shape and returns one plain
output shape.

```js
const engine = require("agent-engine");

const result = await engine.run({
  userId: "u_42",
  conversationId: "c_7",
  text: "what did we decide about the migration?",
});

console.log(result.text);
```

---

## Why this exists

Most agent frameworks make you choose between a toy that forgets everything
between turns and a platform that owns your whole application. This one is a
library: it manages the parts that are genuinely hard — memory that stays
bounded as it grows, tool loops that terminate, model output you can trust
enough to act on — and stays out of everything else.

The design bias throughout is **fail-open**. Memory lookups, tool calls,
citation expansion, and the critique pass all degrade to a usable reply rather
than an exception. The one outcome treated as unacceptable is a user getting
silence.

---

## Architecture

```
                     ┌──────────────────────────────┐
   AgentInput ──────►│          agent/loop          │──────► AgentOutput
 { userId,           │                              │        { text,
   conversationId,   │  assemble → call → dispatch  │          attachments,
   text, ... }       │     → guard → critique       │          toolCalls,
                     └───┬───────────┬───────────┬──┘          usage }
                         │           │           │
              ┌──────────▼──┐  ┌─────▼─────┐  ┌──▼─────────┐
              │   memory    │  │   tools   │  │    llm     │
              │             │  │           │  │            │
              │ facts       │  │ registry  │  │  router    │
              │ summaries   │  │ builtins  │  │  ├ chat    │
              │ episodes    │  │ your own  │  │  ├ vision  │
              │ archive     │  └───────────┘  │  ├ image   │
              │ directives  │                 │  └ embed   │
              └──────┬──────┘                 └────────────┘
                     │
              ┌──────▼──────┐  ┌───────────┐  ┌────────────┐
              │   SQLite    │  │   jobs    │  │  schemas   │
              │  (WAL)      │  │  queue    │  │   (ajv)    │
              └─────────────┘  └───────────┘  └────────────┘
```

---

## The four ideas worth stealing

### 1. Provider-agnostic routing with uniform reliability

Every capability maps to an adapter, and the router — not the adapter — owns
retry, timeout, and cost accounting. Adapters stay retry-naive, so policy lives
in exactly one place.

| Capability | Default provider | Swap via |
|---|---|---|
| Chat + streaming | DeepSeek (any OpenAI-compatible endpoint) | `LLM_BASE_URL` |
| Vision | Google Gemini | `VISION_MODEL` |
| Image generation | Cloudflare Workers AI | `IMAGE_MODEL` |
| Embeddings | Cloudflare Workers AI | `EMBED_MODEL` |

Three details that matter in production:

- **Retry is selective.** Only transport failures, 5xx, and 429 retry. A 400 or
  a schema violation fails identically every time; retrying it just burns
  latency and budget.
- **Streaming deliberately does not retry.** Replaying a stream would duplicate
  text the user already saw. Instead it gets a first-chunk timeout *and* a
  per-chunk inactivity watchdog, so a stalled upstream can't hang forever.
- **Cost accounting understands prompt caching.** Cached prefix tokens bill at a
  fraction of fresh ones; a naive `prompt_tokens × rate` overstates spend by an
  order of magnitude on cache-friendly workloads.

Embeddings are cached in SQLite keyed by `sha256(text + model)`, so a model
change invalidates naturally instead of silently mixing vector spaces.

### 2. Tiered memory

Four tiers, each with a different cost/recall tradeoff. The point of the
hierarchy is that **per-turn prompt size stays flat as history grows**:

| Tier | Holds | Retrieval | Bound |
|---|---|---|---|
| **Facts** | `key=value` assertions with provenance | Always in prompt | `MAX_FACTS`, TTL, LLM compaction |
| **Summaries** | Rolling conversation recaps | Always in prompt | `MAX_SUMMARIES` |
| **Episodes** | Specific past events | On demand (`recall_episode`) | 100 per scope |
| **Archive** | Verbatim messages | On demand (`search_history`) | TTL + per-conversation cap |
| **Directives** | Standing behavioral rules | Always in prompt | `MAX_DIRECTIVES` |

Facts carry metadata that makes the store *converge* rather than drift:

```js
{ key: "role", value: "platform engineer", confidence: "high",
  reinforcedCount: 3, updatedAt: 1770000000000, subjectUserId: "u_42" }
```

- Repetition **reinforces**; contradiction **replaces**; silence **expires**.
- Low-confidence extractions (hedges, jokes — `"lol maybe I like X"`) must be
  reinforced before they can influence a reply.
- Dedup and retraction match on `(key, subjectUserId)`, so a fact about one
  person never overwrites the same-keyed fact about another.
- Jaccard overlap catches restatements under a different key, so
  `likes_coffee` and `favorite_drink=coffee` merge instead of contradicting.
- When a store nears its cap, an LLM pass **compacts** duplicate groups — before
  facts start being dropped, not after.

Older tiers compact into newer ones: when the archive exceeds a threshold, the
oldest chunks become one episode and the corresponding summary is pruned, so no
two tiers describe the same period twice.

**Fact selection is relevance-aware.** Recency and reinforcement decide which
facts are *worth* keeping; they are the wrong criteria for deciding which ones
belong in *this* prompt. Each turn's content words are scored against every
fact — a hit on the key (`cat` against `pet_cat_name`) counts for more than a
hit on the value — and `FACT_RELEVANCE_WEIGHT` blends that into the ranking. A
three-month-old fact that answers the question being asked right now outranks
fresh chatter about something else. Set the weight to `0` for the old behavior.

**Standing directives are not facts.** A rule the user expects to hold forever
("never spoil the answer, give hints instead") cannot live in the fact store:
facts expire on a TTL, compete for prompt slots by score, and get merged by the
compactor — three separate ways for a binding rule to silently vanish.
Directives get their own store with no TTL, no compression, no score
competition, and a dedicated high slot in the prompt. They arrive either
through the `set_directive` / `remove_directive` tools or through a
keyword-gated classifier that catches a rule stated in passing, since users
state rules conversationally and rarely think to ask the agent to remember one.
Retraction matches on id, exact text, containment, or paraphrase, so a rule can
be dropped by naming a fragment of it.

**Curated knowledge arrives before the model asks for it.** `lookup_kb` only
fires when the model chooses to call it, which it rarely does on an ambient
turn — so curated entries surfaced only when someone asked outright. A lexical
pre-flight pass scores each inbound turn against the knowledge base locally
(inverse document frequency over titles, tags, and bodies; **no embedding call
per turn**) and injects the best matches as a `[KnowledgeBase]` block. Those
entries are seeded into the citation store, so the model can cite them even
though no tool returned them.

**Identity is anchored on IDs, not names.** A per-conversation participant
registry tracks display-name changes and stamps `previous_name` facts, so a
model never merges two people who share a nickname or splits one who renamed.

### 3. Structured output with retry-on-failure

Model output that drives control flow gets validated against a JSON Schema.
Two entry points with deliberately different failure modes:

**`chatWithSchema`** — for model output you consume:

```js
const res = await schemas.chatWithSchema({
  schemaName: "fact-extraction",
  model: "deepseek-chat",
  messages: [...],
});
res.validated;  // parsed + validated, or null after one failed retry
```

On a violation it retries **once with the validation error fed back** as a
correction turn, then gives up and returns `validated: null` so the caller can
fall back. It also survives prose-wrapped JSON — code fences, preambles, and
trailing chatter — by carving out the first balanced object span while tracking
string state, so a `}` inside a string literal doesn't truncate the parse.

**`validateToolArgs`** — for model-authored tool arguments. **Never throws.** A
violation returns a structured failure that the loop hands back to the model as
a tool result, letting the ReAct loop self-correct on the next iteration:

```js
{ error: "invalid_arguments", details: "/count: must be <= 10" }
```

### 4. Fail-open reliability

The behaviors that keep a turn from ending badly:

- **The tool loop terminates.** On the final iteration, tools are omitted from
  the request entirely. Left available, a model mid-tool-spree calls another one
  and exhausts the budget with nothing synthesized.
- **Read-only tools deduplicate within a turn.** Models re-issue near-identical
  queries when a first result looks thin; normalized argument matching collapses
  `"who wrote the docs?"` and `"the docs — who wrote them"` to one call.
- **Output guards** strip hallucinated attachment markup, URLs invented without
  a web tool having run (a URL the *user* supplied is preserved), and leaked
  provider markup.
- **Citations are verified, not decorative.** A `[[cite:msg:N]]` referencing an
  index no retrieval tool returned is stripped rather than rendered.
- **Self-critique is gated and non-blocking.** A second model reviews only
  replies containing something falsifiable, and runs *after* the reply is
  returned. It fails open — a critique that errors approves the reply.
- **Background work is durable.** Embedding backfill and compaction go through a
  SQLite job queue with exponential backoff and a startup reaper for jobs
  stranded by a crash.

---

## Installation

```bash
git clone <your-fork> agent-engine && cd agent-engine
npm install
cp .env.example .env    # add at minimum LLM_API_KEY
```

Requires **Node.js 18+** (for global `fetch`). `better-sqlite3` builds a native
addon, so a working toolchain is needed on first install.

Try it:

```bash
npm run example
```

`examples/cli-agent.js` is a full terminal chat agent in ~80 lines — streaming,
tool calls, memory, and a custom tool. It exists to demonstrate one property:
the engine has no idea what a terminal is.

---

## The chat CLI

A real chat client on top of the engine — saved transcripts, channels, members,
rendered markdown, and configuration you can change mid-conversation:

```bash
npm run chat
```

```
  ┌───────────────────────────────────────────┐
  │   ▄▀█ █▀▀ █▀▀ █▄░█ ▀█▀   █▀▀ █▄░█ █▀▀ █▄░█ │
  │   █▀█ █▄█ ██▄ █░▀█ ░█░   ██▄ █░▀█ █▄█ █░▀█ │
  └───────────────────────────────────────────┘
  v1.0.0  ·  deepseek-chat
  /help for commands · /channels to switch · /exit to quit

#deploy-questions  14 messages · 2 members
  Cutover plan and open blockers
────────────────────────────────────────────────────────────────────────────────

  as Brendan  │  in #deploy-questions  │  via deepseek-chat
#deploy-questions Brendan › what did we decide about the migration?

▎ Assistant  BOT  6:44 PM
▎ You settled on the two-phase cutover:
▎ • dual-write for a week
▎ • flip reads once the lag graph is flat
    ⚙ recall_context · 1,204 tokens · $0.00019 · 1.4s
```

Anything not starting with `/` goes to the model. Everything terminal-specific
lives in [`cli/`](cli/) — the engine still just receives
`{ userId, conversationId, text }`.

The vocabulary is the one this engine grew up hosting: a session is a **channel**,
speakers are **members**, and messages carry **replies**, **attachments**,
**reactions** and **pins**. All of that is client-side. The engine's input shape
is unchanged; the client simply fills in more of the optional fields it always
accepted (`participants`, `attachments`, `perception`, `replyContext`).

### Channels and history

Transcripts are stored verbatim in `db/cli_chat.sqlite`. That is deliberately
*not* the engine's memory: facts, summaries, and the archive are derived and
pruned on a retention policy, so neither one is a transcript you can scroll.

A channel id doubles as the engine's `conversationId`, so `/join` moves the
memory scope along with the transcript. Channels are addressable by the
`#slug` of their title, by id, or by a unique id prefix.

| Command | Effect |
|---|---|
| `/new [title]` | Create a channel — new transcript *and* new memory scope |
| `/channels` | List channels, most recently active first |
| `/join <#channel\|id>` | Switch by `#name`, id, or unique id prefix |
| `/rename <title>` | Retitle (untitled channels auto-title from the first message) |
| `/topic [text]` | Set the channel topic shown in the header and exports |
| `/delete <#channel>` | Delete a channel and its transcript |
| `/history [n]` | Replay the last n messages, numbered |
| `/search <text> [--all]` | Search this channel, or every channel |
| `/export [file]` | Write the transcript to Markdown, or `.json` for raw records |
| `/clear` | Erase the transcript — engine memory untouched |
| `/forget` | Drop the engine's facts and summaries for this conversation |

`/clear` and `/forget` are separate on purpose: erasing what you can read and
erasing what the model recalls are different intentions, and merging them makes
one of the two happen by accident.

### Messages

`/history` numbers every message, and the message commands take that number —
or a negative offset, where `-1` is the most recent.

| Command | Effect |
|---|---|
| `/reply <n> <text>` | Reply to a message, quoting it to the model as `replyContext` |
| `/retry` | Drop the last exchange and ask again |
| `/edit <n> <text>` | Rewrite a message in the transcript (marked as edited) |
| `/delmsg <n>` | Delete a message; later ones renumber |
| `/react <n> <emoji>` | Toggle a reaction, stored with the transcript |
| `/pin <n>` · `/pins` | Pin a message, list the pinned ones |
| `/attach <path\|url>` | Queue a file or link for your next message |
| `/me <action>` | Send an action message |

`/attach` does what a chat host does with an upload: it keeps the attachment
record (`url`, `contentType`, `name`) for the engine to pass through, *and*
reads what a text model can actually use into `perception`. Links pasted
straight into a message get the same treatment when `urlContext` is on.

`/retry` deletes both halves of the last exchange before re-asking, so the
transcript never ends up holding two answers to one question.

### Members

Memory is anchored on `userId`, so who you are speaking as decides which facts
the engine reads and writes. `/user <name>` switches identity and derives an id
from the name; everyone who has spoken in a channel is passed to the engine as
`participants`, which is what anchors per-participant facts.

| Command | Effect |
|---|---|
| `/members` | Everyone who has spoken here, with counts and last-seen |
| `/user [name]` | Show or change who you are speaking as |
| `/whois [name]` | What the engine knows about a member |
| `/status` | Bot presence: model, tools, uptime, spend |

### Configuration

`/config` lists every setting; `/set <key> <value>` changes one and persists it
to `db/cli-settings.json`. `default` as a value restores the default.

```
> /set stream off
> /set toolDepth 2
> /persona You are a terse release engineer.
```

| Setting | Default | Effect |
|---|---|---|
| `model` | engine default | Chat model id **(restart)** |
| `lowBudget` | `off` | Halve the tool budget, skip critique **(restart)** |
| `stream` | `on` | Stream tokens as they arrive |
| `tools` | `on` | Expose the built-in tools to the model |
| `memory` | `on` | Write facts and summaries after each turn |
| `toolDepth` | engine default | Max tool iterations per turn |
| `persona` | engine default | System persona override |
| `historyDepth` | `20` | Past messages replayed into each turn |
| `userId` / `userName` / `scopeId` | `cli-user` / `You` / `cli` | Identity sent with each turn |
| `botName` | `Assistant` | Display name for the bot |
| `urlContext` | `on` | Fetch links in your message and pass them as perception |
| `showUsage` / `showTools` / `showLatency` | `on` | Per-reply token/cost, tool, and timing footer |

Settings marked **(restart)** map to engine configuration that the agent loop
reads once at module load; the CLI applies them to the environment at startup
and says so when you set one, rather than pretending a live change took.

### Appearance

| Setting | Default | Effect |
|---|---|---|
| `theme` | `discord` | `discord`, `midnight`, or `mono` |
| `color` | `on` | `NO_COLOR` and a non-TTY stdout always win |
| `markdown` | `on` | Render bold, code blocks, lists, quotes, spoilers |
| `compact` | `off` | One line per message instead of author blocks |
| `timestamps` / `statusBar` | `on` | Per-message time; the identity/channel/model strip |
| `typingIndicator` | `on` | "typing…" while the model works |
| `autocomplete` | `on` | The slash-command picker |

Streaming and markdown rendering coexist rather than trade off: an incomplete
line is drawn as plain text and redrawn in place as tokens land, then replaced
with the rendered version the moment its newline arrives. A `**` is not bold
until its partner shows up, so committing early would mean rendering it wrong.

Redirecting output to a file produces a clean, escape-free transcript.

### Inspection

`/tools` lists what the model can call this turn, `/memory` shows the facts,
summaries, standing instructions, and topic the engine currently holds for this
channel and user, and `/stats` reports messages, tokens, and spend. Structured
output is drawn as an embed card so command output never reads as model output.

Ctrl-C clears the line you are typing; twice, or on an empty line, quits.

### The slash-command picker

Typing `/` opens a list under the prompt that narrows as you type:

```
#deploy-questions Brendan › /pin
  ▸ /pin <n>    Pin message #n in this channel.
    /pins       List this channel's pinned messages.
    /unpin <n>  Remove the pin from message #n.
    3 matches · Tab cycles · Esc dismisses
```

Matching is prefix-first, then substring — `/pin` finds `unpin` too, but never
above the exact prefix match. It completes arguments as well as command names,
and offers what the argument actually is rather than a shape to fill in:

| Typing | Offers |
|---|---|
| `/set ` | Setting keys, with what each one does |
| `/set theme ` | `discord`, `midnight`, `mono` — the current one marked |
| `/join ` | Channels, with message counts and last activity |
| `/react `, `/pin `, `/reply ` | Recent messages with their text, not bare numbers |
| `/user `, `/whois ` | Members of this channel |

**Tab inserts as it cycles**, so whatever is highlighted is also what is on the
line — Enter then sends the highlighted candidate. Shift-Tab goes back, Escape
dismisses (typing again brings it back), and a single match completes the word
and moves on to the next argument.

Enter is deliberately *not* intercepted. readline emits its `line` event from
inside its own keypress handler, before any other listener runs, so a picker
cannot veto a submission — cycling has to leave the line already correct rather
than relying on Enter to accept. The picker also steps aside when it cannot
draw honestly: no TTY, a wrapped input line, or a cursor that is not at the end
of the line. And because it runs inside a keypress listener, where an exception
would be unhandled and take the REPL down, any failure just means "no
suggestions" — never a crash while you are typing.

---

## Usage

### The adapter boundary

Everything the engine needs about a turn arrives in one object. This is the
entire integration surface — build it from an HTTP request, a chat webhook, a
queue message, or stdin.

```js
const result = await engine.run(
  {
    userId:           "u_42",         // required — stable speaker id
    conversationId:   "c_7",          // required — stable conversation id
    text:             "what changed?",// required

    userName:         "Alice",        // display name (may change)
    scopeId:          "acme-corp",    // knowledge-base partition
    messageId:        "m_1001",
    timestamp:        Date.now(),
    attachments:      [{ url, contentType, name }],
    participants:     [{ id: "u_43", name: "Bob" }],
    perception:       "…image description or fetched page text…",
    replyContext:     "Bob said: we shipped it Friday",
    metadata:         { /* host passthrough; never inspected */ },
  },
  {
    registry,                 // ToolRegistry (defaults to the built-ins)
    history,                  // prior turns, newest first
    persona,                  // overrides the default persona block
    stream:  { onChunk, onAbort },
    onRevision:  async (revised, original) => { /* edit the sent message */ },
    onProposal:  async (proposal) => { /* notify a reviewer; false = failed */ },
    citationFormatters: { msg: ({ messageId }) => `[[${messageId}]]` },
    updateMemory: true,
  },
);
```

Returns:

```js
{
  text: "…",
  attachments: [{ buffer, mimeType, filename }],
  toolCalls: [{ tool, args, result }],
  usage: { prompt_tokens, completion_tokens, cost_usd },
  streamed: false,
  error: undefined,   // set instead of throwing when a turn fails
}
```

History entries use the same normalized shape:

```js
{ userId, userName, text, messageId, timestamp, isAgent }
```

### Registering tools

A tool is a plain object. Handlers receive `(args, ctx)` — never a platform
object, which is what keeps the tool layer portable.

```js
const registry = new engine.ToolRegistry()
  .registerAll(engine.BUILTIN_TOOLS)
  .register({
    name: "get_deploy_status",
    description: "Get the current deployment status for a service.",
    parameters: {
      type: "object",
      properties: { service: { type: "string", description: "Service name." } },
      required: ["service"],
    },
    sideEffect: false,          // read-only tools are deduplicated per turn
    handler: async (args, ctx) => {
      return { service: args.service, status: await lookup(args.service) };
    },
  });
```

Mark anything that mutates state or contacts the outside world
`sideEffect: true` — those are never cached, because a second call is a second
action.

To validate a tool's arguments, drop a JSON Schema at
`src/schemas/json/tools/<tool_name>.json`. It is picked up automatically; tools
without one pass through unvalidated.

### Built-in tools

| Tool | Purpose | Needs |
|---|---|---|
| `web_search` | Search the web | `SEARCH_API_KEY` |
| `fetch_page` | Read a URL's full text (SSRF-guarded) | — |
| `lookup_kb` | Semantic search over curated knowledge | `CF_*` |
| `propose_kb_entry` | Queue a new entry **for human review** | — |
| `search_history` | Hybrid FTS + semantic search of past messages | `CF_*` |
| `recall_episode` | Retrieve specific past events | `CF_*` |
| `generate_image` | Text-to-image, attached to the reply | `CF_*` |
| `set_reminder` | Schedule a reminder via the job queue | — |
| `set_directive` | Record a standing behavioral rule for the conversation | — |
| `remove_directive` | Retract a standing rule by id, text, or paraphrase | — |

`propose_kb_entry` deliberately cannot write. An agent that silently edits its
own source of truth will eventually launder a hallucination into it, so
proposals sit pending until a human calls `kb.proposals.approve()`.

### Background jobs

```js
engine.jobs.registerDefaultHandlers(engine.jobs);   // embedding backfill
engine.jobs.register("reminder", async (payload) => {
  await yourPlatform.notify(payload.userId, payload.text);
});
engine.jobs.start();
```

Reminder *delivery* has no default handler on purpose — only the host knows how
to reach a user.

### Shutdown

```js
engine.close();   // stops the queue and checkpoints every SQLite WAL
```

---

## Configuration

All configuration is environment-driven with sane defaults; see
[`.env.example`](.env.example) for the annotated list. The knobs worth knowing:

| Variable | Default | Effect |
|---|---|---|
| `LLM_API_KEY` | — | **Required.** Chat provider credential |
| `LLM_BASE_URL` | `https://api.deepseek.com` | Any OpenAI-compatible endpoint |
| `MAX_TOOL_DEPTH` | `5` | Tool-call iterations before forced synthesis |
| `CHAT_MAX_PROMPT_TOKENS` | `24000` | History trims to fit this budget |
| `SUMMARY_INTERVAL` | `25` | Messages between summarization passes |
| `FACTS_INTERVAL` | `15` | Messages between fact-extraction passes |
| `MAX_FACTS` | `25` | Per-store cap before compaction |
| `FACT_TTL_DAYS` | `90` | Unreinforced facts expire |
| `FACT_RELEVANCE_WEIGHT` | `0.5` | Weight of turn relevance in fact selection |
| `DIRECTIVES_ENABLED` | `true` | Standing behavioral rules per conversation |
| `MAX_DIRECTIVES` | `10` | Directives kept before oldest-first eviction |
| `KB_PREFLIGHT_ENABLED` | `true` | Inject matching KB entries without a tool call |
| `KB_PREFLIGHT_MIN_SCORE` | `0.25` | Lexical match floor for injection |
| `LOW_BUDGET_MODE` | `false` | Halves tool budget, caps facts, skips critique |
| `STREAMING_ENABLED` | `true` | Stream the first response of a turn |

---

## Development

```bash
npm test        # unit + full-turn integration tests
npm run lint
```

The integration suite drives complete turns against a scripted provider stub —
tool dispatch, guards, citation expansion, memory writes — with no network and
no credentials.

Storage layout (all SQLite in WAL mode, all under `db/`):

| File | Contents |
|---|---|
| `memory.sqlite` | Conversation context and user profiles |
| `archive.sqlite` | Message chunks + FTS5 index |
| `episodes.sqlite` | Episodic memory + FTS5 index |
| `kb.sqlite` | Knowledge base and pending proposals |
| `jobs.sqlite` | Durable job queue |
| `embed_cache.sqlite` | Embedding cache |

---

## License

MIT
