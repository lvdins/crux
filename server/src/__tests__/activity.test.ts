// Run: npx tsx server/src/__tests__/activity.test.ts
import assert from "node:assert/strict";
import { agentEnv, termTokenOk } from "../agent-setup.js";
import { allFlows, clean, forgetFlow, graphOf, initActivity, noteHook, redact, type GraphEvent } from "../activity.js";

const sent: any[] = [];
initActivity((msg) => sent.push(msg));

// ---- redaction ----
const secrets = [
  ["key sk-ant-api03-abcdefghijklmnopqrstuv", "sk-ant-api03"],
  ["ghp_abcdefghijklmnopqrstuvwxyz0123", "ghp_abcdefghij"],
  ["glpat-abcdefghijklmnopqrst", "glpat-abcdefghij"],
  ["aws AKIAABCDEFGHIJKLMNOP", "AKIAABCDEFGHIJKLMNOP"],
  ["-H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig'", "eyJhbGciOiJIUzI1NiJ9"],
  ["mysql --password=hunter2 -u root", "hunter2"],
  ["https://x.test/?token=abc123def&x=1", "abc123def"],
  ['{"client_secret": "s3cr3t-value"}', "s3cr3t-value"],
  ["export OPENAI_API_KEY=abcd1234 && run", "abcd1234"],
  ['DB_PASSWORD="p a s s" npm start', "p a s s"],
  ["-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----", "MIIEow"],
] as const;
for (const [text, leak] of secrets) {
  const out = redact(text);
  assert.ok(!out.includes(leak), `leaked ${leak}: ${out}`);
  assert.ok(out.includes("[REDACTED"), `no marker: ${out}`);
}
// Ordinary code stays readable.
for (const text of ["token: string;", "max_tokens: 100", "const tokens = count(text)", "npm test -- auth.spec.ts"]) assert.equal(redact(text), text);
// 32 KB cap.
const big = clean("x".repeat(100_000));
assert.ok(big.length < 33 * 1024 && big.includes("[truncated"));

// ---- normaliser ----
const term = "t-test";
const base = { session_id: "sess-1", transcript_path: "/nonexistent.jsonl", cwd: "/repo" };
const hooks: [string, Record<string, unknown>][] = [
  ["session", { ...base, hook_event_name: "SessionStart", source: "startup" }],
  ["working", { ...base, hook_event_name: "UserPromptSubmit", prompt: "Fix the badge hook, my key is sk-abcdefghijklmnopqrstu" }],
  ["pre", { ...base, hook_event_name: "PreToolUse", tool_name: "Edit", tool_use_id: "toolu_1", tool_input: { file_path: "/repo/src/hooks/badge.ts", old_string: "a", new_string: "b" } }],
  ["working", { ...base, hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: "toolu_1", tool_input: { file_path: "/repo/src/hooks/badge.ts" }, tool_response: { filePath: "/repo/src/hooks/badge.ts" } }],
  ["pre", { ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_2", tool_input: { command: "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz01 npm test" } }],
  ["fail", { ...base, hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_use_id: "toolu_2", tool_input: { command: "npm test" }, error: "Exit code 1\nTests: 2 failed, 10 passed" }],
  ["input", { ...base, hook_event_name: "Notification", message: "Claude needs your permission to use Bash" }],
  // Old-style body without hook_event_name: event decides.
  ["working", { ...base, tool_name: "Read", tool_use_id: "toolu_3", tool_input: { file_path: "/repo/README.md" }, tool_response: "hello" }],
  ["stop", { ...base, hook_event_name: "Stop", last_assistant_message: "Fixed it.\nAll tests pass now." }],
];
const flows: string[] = [];
for (const [event, hook] of hooks) {
  noteHook(term, event, hook);
  flows.push(graphOf(term).flow.activity);
}

const { events, flow } = graphOf(term);
const nodes = new Map<string, any>();
for (const e of events) if (e.node) nodes.set(e.node.id, e.node);
const types = [...nodes.values()].map((n) => n.type);
assert.deepEqual(types, ["session", "prompt", "tool", "tool", "wait", "tool", "done"]);
assert.equal(nodes.get("toolu_1").status, "ok");
assert.equal(nodes.get("toolu_1").label, "Edit hooks/badge.ts");
assert.equal(typeof nodes.get("toolu_1").meta.durationMs, "number");
assert.equal(nodes.get("toolu_2").status, "error");
assert.match(nodes.get("toolu_2").meta.error, /2 failed/);
assert.ok(!JSON.stringify(events).includes("ghp_abcdefghij"), "token leaked into events");
assert.ok(!JSON.stringify(events).includes("sk-abcdefghij"), "key leaked into events");
assert.equal(nodes.get("toolu_3").status, "ok");
assert.equal(nodes.get("toolu_3").meta.output, "hello");
assert.equal([...nodes.values()].find((n) => n.type === "wait").status, "ok", "wait answered by next step");
assert.equal([...nodes.values()].find((n) => n.type === "done").label, "All tests pass now.");
const edges = events.filter((e) => e.op === "edge.add").map((e) => e.edge!);
assert.equal(edges.length, 6);
assert.ok(edges.every((e) => e.kind === "next"));
assert.deepEqual(flows, ["ready", "thinking", "editing badge.ts", "editing badge.ts", "running GITHUB_TOKEN=[REDACTED] npm test", "2 tests failed", "needs your input", "reading README.md", "done"]);
assert.equal(flow.status, "ok");
assert.ok(flow.name.startsWith("Fix the badge hook"));
assert.ok(events.every((e: GraphEvent, i) => e.seq === i + 1 && e.agent.sessionId === "sess-1"));

// Rate cap: 50 new steps a second, completions still pass.
const t2 = "t-rate";
for (let i = 0; i < 120; i++) noteHook(t2, "pre", { ...base, hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: `r${i}`, tool_input: {} });
// At most 50 a second (100 if the loop straddles a second).
const adds = graphOf(t2).events.filter((e) => e.op === "node.add" && e.node!.type === "tool").length;
assert.ok(adds >= 50 && adds <= 100, `rate cap: ${adds}`);

// Batched broadcast.
await new Promise((r) => setTimeout(r, 200));
assert.ok(sent.some((m) => m.type === "graph:event" && m.events.length > 1));
assert.ok(sent.some((m) => m.type === "graph:flow" && m.flow.term === term));

assert.equal(allFlows().length, 2);
forgetFlow(term);
forgetFlow(t2);
assert.equal(allFlows().length, 0);
// Per-terminal hook token.
const env = agentEnv("ws", "/bin/bash", "tok-term");
assert.match(env.CRUX_TOKEN, /^[0-9a-f]{32}$/);
assert.ok(termTokenOk("tok-term", env.CRUX_TOKEN));
assert.ok(!termTokenOk("tok-term", ""));
assert.ok(!termTokenOk("tok-term", "nope"));
assert.ok(termTokenOk("no-token-term", ""), "terms without a token keep working");

console.log("activity: ok");
