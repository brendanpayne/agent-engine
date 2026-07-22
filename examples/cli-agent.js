// A terminal chat agent in ~80 lines.
//
// This example exists to demonstrate one property: the engine has no idea what
// a terminal is. It receives { userId, conversationId, text } and returns text.
// A chat platform integration, an HTTP endpoint, or a voice assistant would
// build the same object from a different source and render the same result.
//
// Run: node examples/cli-agent.js

require("dotenv").config();

const readline = require("readline");
const engine = require("../index.js");

const USER_ID = process.env.EXAMPLE_USER_ID || "local-user";
const USER_NAME = process.env.EXAMPLE_USER_NAME || "You";
const CONVERSATION_ID = process.env.EXAMPLE_CONVERSATION_ID || "cli-session";

// Newest first — the order the engine expects.
const history = [];

function pushHistory(entry) {
  history.unshift(entry);
  if (history.length > 40) history.pop();
}

// Register a custom tool alongside the built-ins, to show the extension point.
const registry = new engine.ToolRegistry()
  .registerAll(engine.BUILTIN_TOOLS)
  .register({
    name: "get_local_time",
    description: "Get the current local time and timezone of the machine running this agent.",
    parameters: { type: "object", properties: {}, required: [] },
    handler: async () => ({
      iso: new Date().toISOString(),
      local: new Date().toLocaleString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
  });

async function main() {
  if (!process.env.LLM_API_KEY) {
    console.error("LLM_API_KEY is not set. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }

  engine.jobs.registerDefaultHandlers(engine.jobs);
  engine.jobs.start();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("agent-engine CLI — type a message, or \"exit\" to quit.\n");

  const ask = () => rl.question("> ", async (line) => {
    const text = line.trim();
    if (!text) return ask();
    if (text === "exit" || text === "quit") return rl.close();

    const messageId = `cli-${Date.now()}`;
    try {
      const result = await engine.run(
        {
          userId: USER_ID,
          userName: USER_NAME,
          conversationId: CONVERSATION_ID,
          scopeId: "cli",
          text,
          messageId,
          timestamp: Date.now(),
        },
        {
          registry,
          history,
          // Stream tokens as they arrive, so the terminal behaves like a chat UI.
          stream: {
            onChunk: (delta) => process.stdout.write(delta),
            onAbort: () => process.stdout.write("\r"),
          },
        },
      );

      if (result.error) {
        console.error(`\n[error] ${result.error}\n`);
      } else {
        // A streamed reply was already printed chunk by chunk.
        if (!result.streamed && result.text) console.log(result.text);
        console.log("");
        for (const a of result.attachments) {
          console.log(`[attachment] ${a.filename} (${a.mimeType}, ${a.buffer.length} bytes)`);
        }
        if (result.toolCalls.length > 0) {
          console.log(`[tools used] ${result.toolCalls.map(t => t.tool).join(", ")}`);
        }
        if (result.usage) {
          console.log(`[usage] ${result.usage.total_tokens ?? "?"} tokens, $${result.usage.cost_usd ?? "?"}\n`);
        }

        pushHistory({ userId: USER_ID, userName: USER_NAME, text, messageId, timestamp: Date.now(), isAgent: false });
        if (result.text) {
          pushHistory({ userId: "agent", userName: "Assistant", text: result.text, messageId: `${messageId}-r`, timestamp: Date.now(), isAgent: true });
        }
      }
    } catch (err) {
      console.error(`\n[fatal] ${err.message}\n`);
    }
    ask();
  });

  rl.on("close", () => {
    console.log("\nClosing databases…");
    engine.close();
    process.exit(0);
  });

  ask();
}

main();
