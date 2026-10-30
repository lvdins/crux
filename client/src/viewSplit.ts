/**
 * Split view: two or more sidebar views (workspaces, Browser, Home, extension
 * views…) side by side or stacked. ⌘-click a sidebar item or session tab to
 * add it beside the focused view; ⌘-drag it (or drag a pane's header) onto an
 * edge of a pane to place it there. The layout is a paneLayout.ts tree whose
 * leaves are pane ids.
 * One pane is focused: it is the app's `view`, so everything that follows the
 * current view (shortcuts, the sidebar highlight, new chats) follows it.
 * A workspace pane that isn't focused remembers which chat it shows.
 */
import { leafIds, type PaneNode } from "./paneLayout";

export const MAX_VIEW_PANES = 4;
/** Pane id of the view shown when nothing is split (kept mounted when a split starts). */
export const SOLO = "solo";

export type ViewPane = { id: string; view: string; chat?: string };
export type ViewSplit = { panes: ViewPane[]; focus: number; tree: PaneNode };

const KEY = "crux.viewSplit";

/** Panes in a row (older saves, and the fallback for a bad tree). */
export const rowOf = (panes: ViewPane[], sizes?: number[]): PaneNode => ({
  kind: "split",
  dir: "row",
  children: panes.map((p) => ({ kind: "leaf", id: p.id })),
  sizes: panes.map((_, i) => (Number(sizes?.[i]) > 0 ? Number(sizes![i]) : 1)),
});

/** Swap one leaf of the tree for another pane. */
export function replaceLeaf(node: PaneNode, from: string, to: string): PaneNode {
  if (node.kind === "leaf") return node.id === from ? { kind: "leaf", id: to } : node;
  return { ...node, children: node.children.map((c) => replaceLeaf(c, from, to)) };
}

function parseSplit(raw: unknown): ViewSplit | null {
  const s = raw as (ViewSplit & { sizes?: number[] }) | null;
  if (!s || !Array.isArray(s.panes)) return null;
  const panes = s.panes.slice(0, MAX_VIEW_PANES).filter((p) => p && typeof p.view === "string" && typeof p.id === "string");
  if (panes.length < 2) return null;
  const ids = panes.map((p) => p.id).sort().join();
  const tree = s.tree && leafIds(s.tree).sort().join() === ids ? s.tree : rowOf(panes, s.sizes);
  return { panes, focus: Math.min(Math.max(0, s.focus | 0), panes.length - 1), tree };
}

/**
 * A split is kept as a group: showing a view outside it leaves the group as
 * it is (its own sidebar row), and picking the group brings the split back.
 */
export type ViewGroup = { id: string; name?: string; split: ViewSplit };
export type ViewGroups = { groups: ViewGroup[]; active: string | null };

const GROUPS_KEY = "crux.viewGroups";

export function loadViewGroups(): ViewGroups {
  try {
    const raw = JSON.parse(localStorage.getItem(GROUPS_KEY) ?? "null") as ViewGroups | null;
    if (raw && Array.isArray(raw.groups)) {
      const groups = raw.groups.flatMap((g): ViewGroup[] => {
        const split = parseSplit(g?.split);
        if (!g?.id || !split) return [];
        return [{ id: String(g.id), name: typeof g.name === "string" ? g.name : undefined, split }];
      });
      return { groups, active: groups.some((g) => g.id === raw.active) ? raw.active : null };
    }
    // Before groups: the one split there was comes back as the open group.
    const old = parseSplit(JSON.parse(localStorage.getItem(KEY) ?? "null"));
    if (!old) return { groups: [], active: null };
    const id = newPaneId();
    return { groups: [{ id, split: old }], active: id };
  } catch {
    return { groups: [], active: null };
  }
}

export function saveViewGroups(g: ViewGroups) {
  try {
    localStorage.setItem(GROUPS_KEY, JSON.stringify(g));
    localStorage.removeItem(KEY);
  } catch {
    /* private mode */
  }
}

export const newPaneId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
