// Stub for the "modules" branch: the pipeline worker's activity.ts replaces it at merge.

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

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function setFlowModule(term: string, m: FlowModule, planned: FlowModule[]): void {}
