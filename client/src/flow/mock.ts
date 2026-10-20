import type { FlowModule, FlowState, GraphEdge, GraphEvent, GraphNode, NodeStatus } from "../types";

/**
 * Dev fixture for the Flow view (`?flowMock=1`, dev builds only): three flows
 * in different modules — one live, one stuck in a failing test loop, one
 * waiting for input. The live one keeps adding steps.
 */
interface Sink {
  applyEvents: (events: GraphEvent[]) => void;
  applySnapshot: (term: string, events: GraphEvent[], flow?: FlowState) => void;
  setFlow: (flow: FlowState) => void;
}

const mod = (id: string, label: string): FlowModule => ({ id, label });
const PRESETS = mod("presets", "Presets");
const BADGES = mod("badges", "Badges");
const BILLING = mod("billing", "Billing");
const CHECKOUT = mod("checkout", "Checkout");
const AUTH = mod("auth", "Auth");
const SHARED = mod("shared", "Shared UI");

let seq = 0;
type Step = Omit<GraphNode, "meta" | "status"> & { status?: NodeStatus; meta?: GraphNode["meta"] };

/** A straight chain of steps, each joined to the one before by a "next" edge. */
function chain(term: string, ws: string, kind: "claude" | "codex", steps: Step[]): GraphEvent[] {
  const out: GraphEvent[] = [];
  const base = { term, ws, agent: { kind, sessionId: `mock-${term}` } };
  steps.forEach((s, i) => {
    const node: GraphNode = { status: "ok", meta: {}, ...s };
    out.push({ ...base, seq: ++seq, ts: Date.now() - (steps.length - i) * 4000, op: "node.add", node });
    if (i > 0) {
      const edge: GraphEdge = { from: steps[i - 1].id, to: s.id, kind: "next" };
      out.push({ ...base, seq: ++seq, ts: Date.now(), op: "edge.add", edge });
    }
  });
  return out;
}

const read = (id: string, file: string, module: FlowModule): Step => ({
  id, type: "tool", label: `Read ${file}`, meta: { tool: "Read", input: JSON.stringify({ file_path: file }, null, 2), output: `// ${file}\nexport …`, durationMs: 40, module, files: [file] },
});
const edit = (id: string, file: string, module: FlowModule, text?: string): Step => ({
  id, type: "tool", label: `Edit ${file.split("/").pop()}`,
  meta: { tool: "Edit", input: JSON.stringify({ file_path: file, old_string: "…", new_string: "…" }, null, 2), output: "ok", durationMs: 120, module, files: [file], ...(text ? { text } : {}) },
});
const bash = (id: string, cmd: string, module: FlowModule, fail?: string): Step => ({
  id, type: "tool", label: `Bash ${cmd}`, status: fail ? "error" : "ok",
  meta: { tool: "Bash", input: cmd, output: fail ? `FAIL ${fail}` : "✓ done", error: fail, durationMs: 8400, module },
});

const T1 = "mock-ws:1:badge", T2 = "mock-ws:2:billing", T3 = "mock-ws:3:auth";

function badgeFlow(): [GraphEvent[], FlowState] {
  const steps: Step[] = [
    { id: "b0", type: "session", label: "claude · giraffe360 · main" },
    { id: "b1", type: "prompt", label: "Show the unseen-preset badge on the presets list" },
    read("b2", "src/presets/index.ts", PRESETS),
    read("b3", "src/presets/PresetList.tsx", PRESETS),
    read("b4", "src/presets/usePresets.ts", PRESETS),
    read("b5", "src/badges/Badge.tsx", BADGES),
    {
      ...edit("b6", "src/badges/useBadge.ts", BADGES, "The badge count comes from usePresets, but it never reads `seenAt`. I'll add a selector in the badge hook that compares each preset's updatedAt with the user's last visit, so the list and the badge agree."),
      status: "running",
    },
  ];
  return [
    chain(T1, "giraffe360", "claude", steps),
    {
      term: T1, name: "presets badge", ws: "giraffe360", agent: "claude", status: "running", activity: "editing badge hook",
      currentModule: BADGES, visitedModules: [PRESETS, BADGES], plannedModules: [SHARED],
    },
  ];
}

function billingFlow(): [GraphEvent[], FlowState] {
  const steps: Step[] = [
    { id: "c0", type: "session", label: "claude · e2e · billing" },
    { id: "c1", type: "prompt", label: "Fix the flaky checkout spec and make the billing suite green" },
    read("c2", "tests/billing/checkout.spec.ts", BILLING),
    read("c3", "tests/billing/fixtures.ts", BILLING),
    read("c4", "tests/billing/invoice.spec.ts", BILLING),
    bash("c5", "npx playwright test tests/billing", BILLING, "2 tests failed: checkout.spec.ts:42, invoice.spec.ts:18"),
    edit("c6", "tests/billing/checkout.spec.ts", BILLING, "The checkout button is disabled until the price loads; waiting for the price row first."),
    bash("c7", "npx playwright test tests/billing", BILLING, "1 test failed: invoice.spec.ts:18"),
    edit("c8", "tests/billing/invoice.spec.ts", BILLING),
    bash("c9", "npx playwright test tests/billing", BILLING, "2 tests failed: invoice.spec.ts:18, invoice.spec.ts:31"),
  ];
  return [
    chain(T2, "e2e", "claude", steps),
    {
      term: T2, name: "billing suite", ws: "e2e", agent: "claude", status: "error", activity: "2 tests failed",
      currentModule: BILLING, visitedModules: [BILLING], plannedModules: [CHECKOUT],
    },
  ];
}

function authFlow(): [GraphEvent[], FlowState] {
  const steps: Step[] = [
    { id: "a0", type: "session", label: "codex · backend · main" },
    { id: "a1", type: "prompt", label: "Review the token refresh change" },
    read("a2", "auth/tokens.py", AUTH),
    read("a3", "auth/views.py", AUTH),
    { id: "a4", type: "subagent", label: "Subagent: code review", meta: { module: AUTH, text: "Two issues: the refresh window ignores clock skew, and the old token stays valid after rotation." } },
    { id: "a5", type: "wait", label: "Asks to run rm -rf build", status: "waiting", meta: { module: AUTH, input: "rm -rf build && make test" } },
  ];
  return [
    chain(T3, "backend", "codex", steps),
    {
      term: T3, name: "token refresh review", ws: "backend", agent: "codex", status: "waiting", activity: "needs your input",
      currentModule: AUTH, visitedModules: [SHARED, AUTH], plannedModules: [],
    },
  ];
}

export function runMock(sink: Sink) {
  for (const make of [badgeFlow, billingFlow, authFlow]) {
    const [events, flow] = make();
    sink.applySnapshot(flow.term, events, flow);
  }
  // The badge flow keeps working: a new step every 2.5 s.
  const cycle: [string, string, FlowModule][] = [
    ["Read", "src/badges/Badge.test.tsx", BADGES],
    ["Read", "src/shared/Pill.tsx", SHARED],
    ["Edit", "src/badges/Badge.tsx", BADGES],
    ["Bash", "npm test -- badge", BADGES],
  ];
  let prev = { ...edit("b6", "src/badges/useBadge.ts", BADGES), status: "running" } as GraphNode;
  let n = 0;
  const base = { term: T1, ws: "giraffe360", agent: { kind: "claude" as const } };
  setInterval(() => {
    if (n >= 60) return;
    const [tool, arg, module] = cycle[n % cycle.length];
    const step = tool === "Bash" ? bash(`live${n}`, arg, module) : tool === "Edit" ? edit(`live${n}`, arg, module) : read(`live${n}`, arg, module);
    const node = { ...step, status: "running", meta: step.meta ?? {} } as GraphNode;
    n++;
    sink.applyEvents([
      { ...base, seq: ++seq, ts: Date.now(), op: "node.update", node: { ...prev, status: "ok" } },
      { ...base, seq: ++seq, ts: Date.now(), op: "node.add", node },
      { ...base, seq: ++seq, ts: Date.now(), op: "edge.add", edge: { from: prev.id, to: node.id, kind: "next" } },
    ]);
    sink.setFlow({
      term: T1, name: "presets badge", ws: "giraffe360", agent: "claude", status: "running",
      activity: tool === "Bash" ? "running badge tests" : tool === "Edit" ? "editing badge" : `reading ${arg.split("/").pop()}`,
      currentModule: module, visitedModules: module === SHARED ? [PRESETS, BADGES, SHARED] : [PRESETS, BADGES, ...(n > 2 ? [SHARED] : [])],
      plannedModules: n > 2 ? [] : [SHARED],
    });
    prev = node;
  }, 2500);
}
