import dagre from "@dagrejs/dagre";
import type { GraphNode, NodeStatus } from "../types";
import type { TermGraph } from "./store";

/** Most boxes one chart draws (the newest). */
export const MAX_BOXES = 500;

export type TypeFilter = "all" | "noReads" | "editsShell";
export type StatusFilter = "all" | "problems";
export interface ChartFilters {
  module: string | null;
  type: TypeFilter;
  status: StatusFilter;
}

/** One drawn box: a step, or a run of the same tool folded into one. */
export interface Box {
  id: string;
  /** The newest step (the fold's face). */
  node: GraphNode;
  members: GraphNode[];
  status: NodeStatus;
  /** Thinking / reply text: the newest member's that has any. */
  text?: string;
  x: number;
  y: number;
}
export interface ChartEdge {
  id: string;
  from: string;
  to: string;
  kind: string;
  /** Joins two boxes whose steps between them are filtered out. */
  implied?: boolean;
}

const READS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);
const EDITS_SHELL = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "Bash", "apply_patch", "shell", "exec_command"]);

export const BOX_W = 220;
const BOX_H = 58;
const TEXT_H = 38;

function passes(n: GraphNode, f: ChartFilters): boolean {
  if (f.module && n.meta.module?.id !== f.module) return false;
  if (f.status === "problems" && n.status !== "error" && n.status !== "waiting") return false;
  const tool = n.meta.tool ?? "";
  if (f.type === "noReads" && n.type === "tool" && READS.has(tool)) return false;
  if (f.type === "editsShell" && !(n.type === "tool" && EDITS_SHELL.has(tool))) return false;
  return true;
}

const worst = (ms: GraphNode[]): NodeStatus =>
  ms.some((m) => m.status === "running") ? "running" : ms.some((m) => m.status === "waiting") ? "waiting" : ms.some((m) => m.status === "error") ? "error" : "ok";

/**
 * Filtered, folded, laid-out boxes for one terminal's graph. Consecutive
 * calls of one tool in one module fold into a box; steps in `expanded` stand alone.
 */
export function buildChart(g: TermGraph, f: ChartFilters, expanded: Set<string>): { boxes: Box[]; edges: ChartEdge[]; hidden: number } {
  const runs: GraphNode[][] = [];
  for (const id of g.order) {
    const n = g.nodes.get(id);
    if (!n || !passes(n, f)) continue;
    const run = runs[runs.length - 1];
    const head = run?.[0];
    const folds = head && n.type === "tool" && head.type === "tool" && !!n.meta.tool && head.meta.tool === n.meta.tool && head.parent === n.parent &&
      head.meta.module?.id === n.meta.module?.id && !expanded.has(head.id) && !expanded.has(n.id);
    if (folds) run.push(n);
    else runs.push([n]);
  }
  const hidden = Math.max(0, runs.length - MAX_BOXES);
  const boxes: Box[] = runs.slice(hidden).map((ms) => {
    const node = ms[ms.length - 1];
    return {
      id: ms.length > 1 ? `fold:${ms[0].id}` : node.id,
      node,
      members: ms,
      status: worst(ms),
      text: [...ms].reverse().find((m) => m.meta.text)?.meta.text,
      x: 0,
      y: 0,
    };
  });

  const boxOf = new Map<string, string>();
  boxes.forEach((b) => b.members.forEach((m) => boxOf.set(m.id, b.id)));
  const edges: ChartEdge[] = [];
  const seen = new Set<string>();
  const add = (from: string, to: string, kind: string, implied?: boolean) => {
    const id = `${from}>${to}`;
    if (from === to || seen.has(id)) return;
    seen.add(id);
    edges.push({ id, from, to, kind, implied });
  };
  for (const e of g.edges) {
    const a = boxOf.get(e.from), b = boxOf.get(e.to);
    if (a && b) add(a, b, e.kind);
  }
  // Boxes left without an incoming edge (their source filtered away) join the box before.
  const hasIn = new Set(edges.map((e) => e.to));
  boxes.forEach((b, i) => i > 0 && !hasIn.has(b.id) && add(boxes[i - 1].id, b.id, "next", true));

  const dg = new dagre.graphlib.Graph();
  dg.setGraph({ rankdir: "LR", nodesep: 26, ranksep: 46, marginx: 20, marginy: 20 });
  dg.setDefaultEdgeLabel(() => ({}));
  boxes.forEach((b) => dg.setNode(b.id, { width: BOX_W, height: BOX_H + (b.text ? TEXT_H : 0) }));
  edges.forEach((e) => dg.setEdge(e.from, e.to));
  dagre.layout(dg);
  for (const b of boxes) {
    const p = dg.node(b.id);
    b.x = p.x - p.width / 2;
    b.y = p.y - p.height / 2;
  }
  return { boxes, edges, hidden };
}
