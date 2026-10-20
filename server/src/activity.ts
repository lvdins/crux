import path from "node:path";
import { config } from "./config.js";
import { fullReply } from "./agent-setup.js";
import { plannedModules, resolveModule, forgetTerm as forgetModules } from "./flowModules.js";

/**
 * Live agent activity for the Flow view. Claude hook events (see
 * agent-setup.ts, /api/agent-event) become GraphEvents: a session, prompt,
 * tool, wait and done node per step, joined by "next" edges. Each terminal
 * keeps a ring of recent events and a FlowState (status, what it is doing,
 * which module it is in). Clients get `graph:event` batches, `graph:flow`
 * on changes and a `graph:snapshot` on term:open.
 */

export type NodeStatus = "running" | "ok" | "error" | "waiting";
export type NodeType = "session" | "prompt" | "tool" | "subagent" | "worker" | "wait" | "done";
export interface FlowModule { id: string; label: string }
export interface GraphNode {
  id: string; type: NodeType; label: string; status: NodeStatus; parent?: string;
  meta: {
    tool?: string; input?: string; output?: string; error?: string;   // redacted, max 32 KB each
    durationMs?: number; module?: FlowModule; text?: string;            // text = assistant/thinking text if known
    files?: string[]; url?: string;
  };
}
export interface GraphEdge { from: string; to: string; kind: "next" | "spawns" | "calls" | "answers" }
export interface GraphEvent {
  seq: number; ts: number; term: string; ws?: string;
  agent: { kind: "claude" | "codex"; sessionId?: string; agentId?: string };
  op: "node.add" | "node.update" | "edge.add";
  node?: GraphNode; edge?: GraphEdge;
}
export interface FlowState {
  term: string; name: string; ws?: string; agent: "claude" | "codex";
  status: NodeStatus; activity: string;          // e.g. "editing badge hook", "2 tests failed", "needs your input"
  currentModule?: FlowModule; visitedModules: FlowModule[]; plannedModules: FlowModule[];
}

type Hook = Record<string, unknown>;

const RING = 2000;
const MAX_NODES = 4000;
const RATE = 50; // new nodes per second per terminal
const BATCH_MS = 150;
const MAX_TEXT = 32 * 1024;

interface TermFlow {
  events: GraphEvent[];
  flow: FlowState;
  seq: number;
  nodes: Map<string, GraphNode>;
  started: Map<string, number>; // tool node id -> PreToolUse time
  session?: string; // current session node id
  sessionId?: string;
  last?: string; // last node, for "next" edges
  wait?: string; // open wait node
  module?: FlowModule; // last step's module
  named: boolean; // name taken from the first prompt
  n: number; // id counter for nodes without an agent-made id
  rate: { sec: number; count: number };
  sentFlow: string;
}

const terms = new Map<string, TermFlow>();
let broadcast: (msg: unknown) => void = () => {};
let pending: GraphEvent[] = [];
const dirtyFlows = new Set<string>();
let timer: NodeJS.Timeout | null = null;

export function initActivity(send: (msg: unknown) => void): void {
  broadcast = send;
}

// ---- redaction / text ----

const SECRETS: [RegExp, string | ((...m: string[]) => string)][] = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "sk-[REDACTED]"],
  [/\b(gh[pousr]_)[A-Za-z0-9]{20,}/g, "$1[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "github_pat_[REDACTED]"],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, "glpat-[REDACTED]"],
  [/\b(xox[abprs]-)[A-Za-z0-9-]{10,}/g, "$1[REDACTED]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "AKIA[REDACTED]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]"],
  // KEY=value env style: API_KEY=…, GITHUB_TOKEN="…", DB_PASSWORD='…'
  [/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|CREDENTIALS?|AUTH)[A-Z0-9_]*)=("[^"\n]*"|'[^'\n]*'|[^\s"'&;|]+)/g, "$1=[REDACTED]"],
  // password=…, access_token=…, "secret": "…" (a colon needs a quoted value, so `token: string` stays)
  [/\b([\w-]*(?:password|passwd|token|secret|api[_-]?key))(["']?\s*=\s*["']?)[^\s"'&,;)]+/gi, "$1$2[REDACTED]"],
  [/\b([\w-]*(?:password|passwd|token|secret|api[_-]?key))(["']?\s*:\s*["'])[^"'\n]+/gi, "$1$2[REDACTED]"],
];

/** Masks tokens, keys and passwords. */
export function redact(text: string): string {
  let out = text;
  for (const [re, to] of SECRETS) out = out.replace(re, to as string);
  return out;
}

/** Redacted, at most 32 KB. */
export function clean(text: string, max = MAX_TEXT): string {
  // Cap before the regexes so a huge payload stays cheap.
  const out = redact(text.length > max * 4 ? text.slice(0, max * 4) : text);
  return out.length > max ? out.slice(0, max) + `\n…[truncated ${text.length - max} chars]` : out;
}

const oneLine = (text: string, max = 60) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
};

const str = (o: Hook | undefined, k: string) => (o && typeof o[k] === "string" ? (o[k] as string) : "");
const asText = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object" && ("stdout" in v || "stderr" in v)) {
    const r = v as Hook;
    return [str(r, "stdout"), str(r, "stderr")].filter(Boolean).join("\n");
  }
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
};

// mcp__crux-browser__browser_click -> browser_click
const shortTool = (name: string) => (name.startsWith("mcp__") ? name.split("__").slice(2).join("__") || name : name);
const shortPath = (p: string) => p.split(/[\\/]/).filter(Boolean).slice(-2).join("/");

/** "Read presets/index.ts", "Bash npm test". */
function toolLabel(name: string, input: Hook): string {
  const file = str(input, "file_path") || str(input, "notebook_path");
  const detail =
    (file && shortPath(file)) || str(input, "command") || str(input, "pattern") || str(input, "url") || str(input, "query") || str(input, "description") || str(input, "prompt");
  return oneLine(redact(detail ? `${shortTool(name)} ${detail}` : shortTool(name)));
}

/** What the agent is doing, for the flows overview: "editing badge.ts". */
function toolActivity(name: string, input: Hook): string {
  const file = str(input, "file_path") || str(input, "notebook_path");
  const base = file && path.basename(file);
  let line: string;
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(name)) line = `editing ${base || "files"}`;
  else if (name === "Read") line = `reading ${base || "files"}`;
  else if (name === "Bash") line = str(input, "description") ? str(input, "description").replace(/^\w/, (c) => c.toLowerCase()) : `running ${str(input, "command")}`;
  else if (name === "Grep" || name === "Glob") line = `searching ${str(input, "pattern")}`;
  else if (name === "WebFetch") line = `fetching ${hostOf(str(input, "url"))}`;
  else if (name === "WebSearch") line = `searching the web`;
  else if (name === "Task" || name === "Agent") line = `running a subagent`;
  else line = shortTool(name).replace(/_/g, " ");
  return oneLine(redact(line), 50);
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** "2 tests failed", or "Bash failed". */
function failActivity(name: string, text: string): string {
  const m = /(\d+)\s+(?:tests?\s+)?(?:failed|failing|failures?)\b/i.exec(text);
  if (m) return `${m[1]} test${m[1] === "1" ? "" : "s"} failed`;
  return `${shortTool(name)} failed`;
}

const toolFiles = (input: Hook) => [str(input, "file_path"), str(input, "notebook_path")].filter(Boolean);

// ---- state ----

function flowOf(term: string): TermFlow {
  let t = terms.get(term);
  if (!t) {
    t = {
      events: [],
      flow: { term, name: "", agent: "claude", status: "ok", activity: "", visitedModules: [], plannedModules: [] },
      seq: 0,
      nodes: new Map(),
      started: new Map(),
      named: false,
      n: 0,
      rate: { sec: 0, count: 0 },
      sentFlow: "",
    };
    t.flow.name = defaultName(t);
    terms.set(term, t);
  }
  return t;
}

const defaultName = (t: TermFlow) => {
  const label = t.flow.ws ? config.repos[t.flow.ws]?.label || t.flow.ws : "";
  return label ? `claude · ${label}` : "claude";
};

/** A terminal's workspace (term:open / worker start). */
export function bindTerm(term: string, ws: string): void {
  const t = flowOf(term);
  if (t.flow.ws === ws) return;
  t.flow.ws = ws;
  for (const e of t.events) e.ws ??= ws;
  if (!t.named) t.flow.name = defaultName(t);
  flowChanged(term, t);
}

function emit(term: string, t: TermFlow, op: GraphEvent["op"], body: { node?: GraphNode; edge?: GraphEdge }): void {
  const ev: GraphEvent = {
    seq: ++t.seq,
    ts: Date.now(),
    term,
    ws: t.flow.ws,
    agent: { kind: "claude", sessionId: t.sessionId },
    op,
    // Copy: later updates must not rewrite events already sent.
    ...(body.node ? { node: { ...body.node, meta: { ...body.node.meta } } } : {}),
    ...(body.edge ? { edge: body.edge } : {}),
  };
  t.events.push(ev);
  if (t.events.length > RING) t.events.splice(0, t.events.length - RING);
  pending.push(ev);
  schedule();
}

function addNode(term: string, t: TermFlow, node: GraphNode): void {
  t.nodes.set(node.id, node);
  if (t.nodes.size > MAX_NODES) t.nodes.delete(t.nodes.keys().next().value!);
  emit(term, t, "node.add", { node });
  if (t.last && t.last !== node.id) emit(term, t, "edge.add", { edge: { from: t.last, to: node.id, kind: "next" } });
  t.last = node.id;
}

const update = (term: string, t: TermFlow, node: GraphNode) => emit(term, t, "node.update", { node });

function flowChanged(term: string, t: TermFlow): void {
  t.flow.plannedModules = plannedModules(term);
  const key = JSON.stringify(t.flow);
  if (key === t.sentFlow) return;
  t.sentFlow = key;
  dirtyFlows.add(term);
  schedule();
}

function schedule(): void {
  if (timer) return;
  timer = setTimeout(flush, BATCH_MS);
  timer.unref?.();
}

function flush(): void {
  timer = null;
  if (pending.length) broadcast({ type: "graph:event", events: pending });
  pending = [];
  for (const term of dirtyFlows) {
    const t = terms.get(term);
    if (t) broadcast({ type: "graph:flow", flow: t.flow });
  }
  dirtyFlows.clear();
}

function enterModule(t: TermFlow, m: FlowModule): void {
  t.module = m;
  t.flow.currentModule = m;
  if (!t.flow.visitedModules.some((v) => v.id === m.id)) t.flow.visitedModules.push(m);
}

/** Over 50 new steps a second: drop the rest (updates of known steps still pass). */
function overRate(t: TermFlow): boolean {
  const sec = Math.floor(Date.now() / 1000);
  if (t.rate.sec !== sec) t.rate = { sec, count: 0 };
  return ++t.rate.count > RATE;
}

/** Claude hook event name: the body's own, else from the route's event. */
export function hookName(event: string, hook: Hook): string {
  const own = str(hook, "hook_event_name");
  if (own) return own;
  const byEvent: Record<string, string> = { pre: "PreToolUse", fail: "PostToolUseFailure", session: "SessionStart", stop: "Stop", input: "Notification" };
  return byEvent[event] ?? (str(hook, "prompt") ? "UserPromptSubmit" : str(hook, "tool_name") ? "PostToolUse" : "");
}

/** One Claude hook event (full hook JSON) for a terminal. */
export function noteHook(term: string, event: string, hook: Hook): void {
  const name = hookName(event, hook);
  if (!name) return;
  const t = flowOf(term);
  const sid = str(hook, "session_id");
  const toolName = str(hook, "tool_name");
  const input = (hook.tool_input && typeof hook.tool_input === "object" ? hook.tool_input : {}) as Hook;
  const toolId = str(hook, "tool_use_id");
  const known = toolId ? t.nodes.get(toolId) : undefined;
  // Completing a step we already drew always passes; new steps are capped.
  const completes = known && (name === "PostToolUse" || name === "PostToolUseFailure");
  if (!completes && name !== "Stop" && overRate(t)) return;

  // Session node: on SessionStart, a new session id, or the first event.
  if (name === "SessionStart" || !t.session || (sid && t.sessionId && sid !== t.sessionId)) {
    if (t.session) {
      const prev = t.nodes.get(t.session);
      if (prev && prev.status !== "ok") update(term, t, Object.assign(prev, { status: "ok" as const }));
    }
    if (sid) t.sessionId = sid;
    const label = t.flow.ws ? config.repos[t.flow.ws]?.label || t.flow.ws : "";
    const node: GraphNode = { id: `session:${sid || `${term}:${++t.n}`}`, type: "session", label: label ? `claude · ${label}` : "claude", status: "running", meta: {} };
    // Same session announced twice (SessionStart, then resume): reuse it.
    if (t.nodes.has(node.id)) t.session = node.id;
    else {
      addNode(term, t, node);
      t.session = node.id;
    }
    if (name === "SessionStart") {
      t.flow.status = "ok";
      t.flow.activity = "ready";
      flowChanged(term, t);
      return;
    }
  }
  const parent = t.session;

  // Any step after a wait answers it.
  if (t.wait && name !== "Notification") {
    const w = t.nodes.get(t.wait);
    t.wait = undefined;
    if (w && w.status === "waiting") update(term, t, Object.assign(w, { status: "ok" as const }));
  }

  switch (name) {
    case "UserPromptSubmit": {
      const prompt = str(hook, "prompt");
      addNode(term, t, { id: `prompt:${term}:${++t.n}`, type: "prompt", label: oneLine(redact(prompt)), status: "ok", parent, meta: { text: clean(prompt) } });
      if (!t.named && prompt.trim()) {
        t.named = true;
        t.flow.name = oneLine(redact(prompt), 50);
      }
      t.flow.status = "running";
      t.flow.activity = "thinking";
      break;
    }
    case "PreToolUse":
    case "PostToolUse":
    case "PostToolUseFailure": {
      if (!toolName) return;
      const failed = name === "PostToolUseFailure";
      const done = name !== "PreToolUse";
      const id = toolId || `tool:${term}:${++t.n}`;
      let node = t.nodes.get(id);
      const isNew = !node;
      if (!node) {
        node = {
          id,
          type: "tool",
          label: toolLabel(toolName, input),
          status: "running",
          parent,
          meta: { tool: toolName, input: clean(asText(input)) },
        };
        const files = toolFiles(input);
        if (files.length) node.meta.files = files;
        if (str(input, "url")) node.meta.url = clean(str(input, "url"), 2048);
        t.started.set(id, Date.now());
      }
      if (done) {
        const out = asText(hook.tool_response);
        if (out) node.meta.output = clean(out);
        const err = str(hook, "error") || (failed ? out : "");
        if (failed) node.meta.error = clean(err || "failed");
        node.status = failed ? "error" : "ok";
        const at = t.started.get(id);
        if (at !== undefined && !isNew) node.meta.durationMs = Date.now() - at;
        t.started.delete(id);
      }
      const m = resolveModule(term, node, { toolName, toolInput: input, toolResponse: hook.tool_response });
      if (m) enterModule(t, m);
      if (m || !node.meta.module) node.meta.module = m ?? t.module;
      if (isNew) addNode(term, t, node);
      else update(term, t, node);
      if (failed) {
        t.flow.status = "error";
        t.flow.activity = failActivity(toolName, `${node.meta.error ?? ""}\n${node.meta.output ?? ""}`);
      } else {
        t.flow.status = "running";
        // A completion keeps the line its PreToolUse set.
        if (isNew || !done) t.flow.activity = toolActivity(toolName, input);
      }
      break;
    }
    case "Notification": {
      const msg = str(hook, "message") || "Needs your input";
      const id = `wait:${term}:${++t.n}`;
      addNode(term, t, { id, type: "wait", label: oneLine(redact(msg)), status: "waiting", parent, meta: { text: clean(msg) } });
      t.wait = id;
      t.flow.status = "waiting";
      t.flow.activity = "needs your input";
      break;
    }
    case "Stop": {
      // Steps still running when the turn ends were interrupted.
      for (const id of t.started.keys()) {
        const n = t.nodes.get(id);
        if (n && n.status === "running") update(term, t, Object.assign(n, { status: "error" as const, meta: { ...n.meta, error: "interrupted" } }));
      }
      t.started.clear();
      const reply = fullReply(hook);
      const lastLine = reply.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
      addNode(term, t, { id: `done:${term}:${++t.n}`, type: "done", label: oneLine(redact(lastLine.replace(/[`*#>]+/g, ""))) || "Done", status: "ok", parent, meta: reply ? { text: clean(reply) } : {} });
      t.flow.status = "ok";
      t.flow.activity = "done";
      break;
    }
    default:
      return;
  }
  flowChanged(term, t);
}

/** Module set by the agent (POST /api/flow/module). */
export function setFlowModule(term: string, m: FlowModule, planned: FlowModule[]): void {
  const t = flowOf(term);
  enterModule(t, m);
  t.flow.plannedModules = planned;
  const key = JSON.stringify(t.flow);
  if (key === t.sentFlow) return;
  t.sentFlow = key;
  dirtyFlows.add(term);
  schedule();
}

export function graphOf(term: string): { events: GraphEvent[]; flow: FlowState } {
  const t = terms.get(term);
  if (t) return { events: t.events, flow: t.flow };
  return { events: [], flow: { term, name: "claude", agent: "claude", status: "ok", activity: "", visitedModules: [], plannedModules: [] } };
}

/** Every open terminal that has events. */
export function allFlows(): FlowState[] {
  return [...terms.values()].filter((t) => t.events.length).map((t) => t.flow);
}

/** `graph:snapshot` message for term:open. */
export function snapshotMsg(term: string) {
  return { type: "graph:snapshot", term, ...graphOf(term) };
}

/** Terminal closed. */
export function forgetFlow(term: string): void {
  terms.delete(term);
  dirtyFlows.delete(term);
  pending = pending.filter((e) => e.term !== term);
  forgetModules(term);
}
