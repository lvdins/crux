import type { FlowModule, GraphNode } from "./activity.js";

// STUB: worker "modules" replaces this file with the real resolver.

/** Best module for a step, most specific first; null = inherit previous step's. */
export function resolveModule(
  _term: string,
  _node: GraphNode,
  _raw: { toolName?: string; toolInput?: Record<string, unknown>; toolResponse?: unknown },
): FlowModule | null {
  return null;
}

/** Agent-declared module ("now testing: Billing") + planned next modules. */
export function declareModule(_term: string, _module: string, _next?: string[]): FlowModule | null {
  return null;
}

export function plannedModules(_term: string): FlowModule[] {
  return [];
}

export function forgetTerm(_term: string): void {}
