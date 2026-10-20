import { useSyncExternalStore } from "react";
import { api } from "../net";
import type { FlowState, GraphEdge, GraphEvent, GraphNode } from "../types";

/**
 * Flow view data: one FlowState per terminal plus its step graph, fed by
 * GET /api/graph(/flows) and the graph:* WebSocket messages. Bounded: each
 * terminal keeps its newest MAX_NODES steps.
 */
const MAX_NODES = 2000;

export interface TermGraph {
  nodes: Map<string, GraphNode>;
  /** Node ids in arrival order. */
  order: string[];
  edges: GraphEdge[];
  /** Last applied event seq (older ones are skipped). */
  seq: number;
  /** Bumped on every change, for memos. */
  rev: number;
}

/** Dev only: `?flowMock=1` fills the view from a fixture instead of the server. */
export const FLOW_MOCK = import.meta.env.DEV && new URLSearchParams(location.search).has("flowMock");

const flows = new Map<string, FlowState>();
const graphs = new Map<string, TermGraph>();
let version = 0;
const listeners = new Set<() => void>();
const emit = () => {
  version++;
  listeners.forEach((l) => l());
};

export function useFlowVersion(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
}

export const getFlows = () => [...flows.values()];
export const getFlow = (term: string) => flows.get(term);
export const getGraph = (term: string) => graphs.get(term);

const emptyGraph = (): TermGraph => ({ nodes: new Map(), order: [], edges: [], seq: 0, rev: 0 });

function apply(g: TermGraph, e: GraphEvent) {
  if (e.op === "edge.add" && e.edge) {
    const { from, to, kind } = e.edge;
    if (!g.edges.some((x) => x.from === from && x.to === to && x.kind === kind)) g.edges.push(e.edge);
  } else if (e.node) {
    const prev = g.nodes.get(e.node.id);
    // An update before its add (or a repeat add) merges into what we have.
    if (prev) g.nodes.set(prev.id, { ...prev, ...e.node, meta: { ...prev.meta, ...e.node.meta } });
    else {
      g.nodes.set(e.node.id, e.node);
      g.order.push(e.node.id);
    }
  }
  if (e.seq > g.seq) g.seq = e.seq;
}

function trim(g: TermGraph) {
  if (g.order.length <= MAX_NODES) return;
  const drop = g.order.splice(0, g.order.length - MAX_NODES);
  drop.forEach((id) => g.nodes.delete(id));
  g.edges = g.edges.filter((x) => g.nodes.has(x.from) && g.nodes.has(x.to));
}

export function applyEvents(events: GraphEvent[]) {
  const touched = new Set<TermGraph>();
  for (const e of events) {
    let g = graphs.get(e.term);
    if (!g) graphs.set(e.term, (g = emptyGraph()));
    if (e.seq && e.seq <= g.seq) continue;
    apply(g, e);
    touched.add(g);
  }
  if (!touched.size) return;
  touched.forEach((g) => {
    trim(g);
    g.rev++;
  });
  emit();
}

export function setFlow(flow: FlowState) {
  flows.set(flow.term, flow);
  emit();
}

/** Replaces a terminal's graph wholesale (term:open, or a REST load). */
export function applySnapshot(term: string, events: GraphEvent[], flow?: FlowState) {
  const g = emptyGraph();
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) apply(g, e);
  trim(g);
  g.rev = (graphs.get(term)?.rev ?? 0) + 1;
  graphs.set(term, g);
  if (flow) flows.set(term, flow);
  emit();
}

/** graph:* WebSocket messages; true when handled. */
export function handleGraphMessage(msg: { type?: string; [k: string]: unknown }): boolean {
  if (FLOW_MOCK && typeof msg.type === "string" && msg.type.startsWith("graph:")) return true;
  if (msg.type === "graph:event") applyEvents((msg.events as GraphEvent[]) ?? []);
  else if (msg.type === "graph:flow") msg.flow && setFlow(msg.flow as FlowState);
  else if (msg.type === "graph:snapshot") applySnapshot(String(msg.term), (msg.events as GraphEvent[]) ?? [], msg.flow as FlowState | undefined);
  else return false;
  return true;
}

let mockStarted = false;
async function startMock() {
  if (mockStarted) return;
  mockStarted = true;
  const m = await import("./mock");
  m.runMock({ applyEvents, applySnapshot, setFlow });
}

/** Every open terminal's flow (on opening the view). */
export async function loadFlows(): Promise<void> {
  if (FLOW_MOCK) return startMock();
  const r = await api("/api/graph/flows");
  if (!r.ok) throw new Error(`flows: HTTP ${r.status}`);
  const { flows: list } = (await r.json()) as { flows: FlowState[] };
  // Flows the server no longer lists (terminal closed) go.
  const live = new Set(list.map((f) => f.term));
  for (const t of flows.keys()) if (!live.has(t)) flows.delete(t);
  list.forEach((f) => flows.set(f.term, f));
  emit();
}

/** One terminal's full step graph (on opening its chart). */
export async function loadGraph(term: string): Promise<void> {
  if (FLOW_MOCK) return startMock();
  const r = await api(`/api/graph?term=${encodeURIComponent(term)}`);
  if (!r.ok) throw new Error(`graph: HTTP ${r.status}`);
  const { events, flow } = (await r.json()) as { events: GraphEvent[]; flow: FlowState };
  applySnapshot(term, events, flow);
}
