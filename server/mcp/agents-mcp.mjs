#!/usr/bin/env node
// crux-agents — MCP server (stdio, no dependencies) for an orchestrator lead
// in Crux: start worker agents next to it, steer them and collect results.
// Requests go to the Crux server (server/src/orchestrator.ts).

const LEAD = process.env.CRUX_LEAD;
const TOKEN = process.env.CRUX_TEAM_TOKEN || "";
const BASE = process.env.CRUX_URL || "http://127.0.0.1:8787";

const agent = { type: "string", description: "Worker name, as spawn_agent / list_agents show it" };

const TOOLS = [
  {
    name: "spawn_agent",
    description:
      "Start a worker agent on one self-contained part of the task. It opens as a pane next to you that the user can watch. The worker doesn't see this conversation: give it everything it needs (goal, files, constraints, how to verify, what to report). With git it gets its own worktree and branch.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short name, e.g. ui, tests, docs" },
        task: { type: "string", description: "The worker's complete task" },
        kind: { type: "string", enum: ["claude", "codex"], description: "Agent type, when the team allows both (default claude)" },
        isolated: { type: "boolean", description: "Own git worktree and branch (default true; false = work in the main checkout)" },
      },
      required: ["name", "task"],
    },
  },
  {
    name: "wait_for_agents",
    description:
      "Wait until workers finish (or need input), then get their final messages. Waits up to timeout_seconds (default 300); call again if some are still working.",
    inputSchema: {
      type: "object",
      properties: {
        agents: { type: "array", items: { type: "string" }, description: "Names to wait for (default: every open worker)" },
        until: { type: "string", enum: ["all", "any"], description: "Return when all (default) or any of them settle" },
        timeout_seconds: { type: "number", description: "5 to 600, default 300" },
      },
    },
  },
  {
    name: "list_agents",
    description: "Every worker with its status (working, input, done, closed), branch and latest activity.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_agent",
    description: "A worker's final message, or the end of its terminal when it has none (e.g. a question or permission prompt).",
    inputSchema: { type: "object", properties: { agent }, required: ["agent"] },
  },
  {
    name: "send_to_agent",
    description:
      "Type a message into a worker's prompt and submit it: answer its question, give feedback, or hand it follow-up work. For a permission prompt, send the option number (e.g. \"1\").",
    inputSchema: { type: "object", properties: { agent, message: { type: "string" } }, required: ["agent", "message"] },
  },
  {
    name: "stop_agent",
    description:
      "Close a worker's pane once its work is merged or no longer needed. remove_worktree=true also removes its git worktree (only when it has no uncommitted changes; the branch is kept).",
    inputSchema: { type: "object", properties: { agent, remove_worktree: { type: "boolean" } }, required: ["agent"] },
  },
];

async function call(name, args) {
  if (!LEAD) return { isError: true, content: [{ type: "text", text: "Not an orchestrator lead in Crux (CRUX_LEAD is unset)." }] };
  let body;
  try {
    const res = await fetch(`${BASE}/api/orch/${encodeURIComponent(LEAD)}/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Crux-Team": TOKEN },
      body: JSON.stringify({ args: args ?? {} }),
    });
    body = await res.json();
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: `Crux server unreachable at ${BASE}: ${err.message}` }] };
  }
  if (!body.ok) return { isError: true, content: [{ type: "text", text: body.error || "Failed" }] };
  return { content: [{ type: "text", text: body.text ?? "" }] };
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications (initialized, cancelled, …)
  try {
    if (method === "initialize") {
      return send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "crux-agents", version: "0.1.0" },
          instructions:
            "You lead a team of worker agents in Crux. Plan, spawn_agent per independent part, wait_for_agents, review and merge their branches, stop_agent, then report to the user.",
        },
      });
    }
    if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    if (method === "tools/call") {
      return send({ jsonrpc: "2.0", id, result: await call(params?.name, params?.arguments) });
    }
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (err) {
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(err?.message ?? err) } });
  }
}

let buffer = "";
let inFlight = 0;
let ended = false;
const maybeExit = () => {
  if (ended && inFlight === 0) process.exit(0);
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try {
      inFlight++;
      void handle(JSON.parse(line)).finally(() => {
        inFlight--;
        maybeExit();
      });
    } catch {
      /* ignore malformed lines */
    }
  }
});
process.stdin.on("end", () => {
  ended = true;
  maybeExit();
});
