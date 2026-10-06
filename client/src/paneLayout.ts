/**
 * Terminal pane layout: a small split tree (like VS Code editor groups).
 * A leaf is one terminal; MAIN is the leaf that shows whichever tab is
 * active in the tab strip. Splits lay children out in a row (side by side)
 * or a column (stacked), with relative sizes.
 */

export const MAIN = "__main__";
export const MAX_PANES = 6;

export type PaneNode =
  | { kind: "leaf"; id: string }
  | { kind: "split"; dir: "row" | "col"; children: PaneNode[]; sizes: number[] };

export type DropSide = "left" | "right" | "top" | "bottom";

export const rootLayout = (): PaneNode => ({ kind: "leaf", id: MAIN });

export function leafIds(node: PaneNode): string[] {
  return node.kind === "leaf" ? [node.id] : node.children.flatMap(leafIds);
}

/** Put `newId` beside `targetId` on the given side. */
export function insertAt(root: PaneNode, targetId: string, side: DropSide, newId: string): PaneNode {
  const dir = side === "left" || side === "right" ? "row" : "col";
  const before = side === "left" || side === "top";
  const leaf: PaneNode = { kind: "leaf", id: newId };

  const visit = (node: PaneNode): PaneNode => {
    if (node.kind === "leaf") {
      if (node.id !== targetId) return node;
      return { kind: "split", dir, children: before ? [leaf, node] : [node, leaf], sizes: [1, 1] };
    }
    const i = node.children.findIndex((c) => c.kind === "leaf" && c.id === targetId);
    if (i >= 0 && node.dir === dir) {
      // Same direction: become a sibling, taking half of the target's share.
      const half = node.sizes[i] / 2;
      const children = [...node.children];
      const sizes = [...node.sizes];
      children.splice(before ? i : i + 1, 0, leaf);
      sizes.splice(i, 1, ...(before ? [half, half] : [half, half]));
      return { ...node, children, sizes };
    }
    return { ...node, children: node.children.map(visit) };
  };
  return visit(root);
}

/** Remove a leaf; splits left with one child collapse into it. */
export function removeLeaf(root: PaneNode, id: string): PaneNode {
  const visit = (node: PaneNode): PaneNode | null => {
    if (node.kind === "leaf") return node.id === id ? null : node;
    const kept: { child: PaneNode; size: number }[] = [];
    node.children.forEach((c, i) => {
      const next = visit(c);
      if (next) kept.push({ child: next, size: node.sizes[i] });
    });
    if (kept.length === 0) return null;
    if (kept.length === 1) return kept[0].child;
    return { ...node, children: kept.map((k) => k.child), sizes: kept.map((k) => k.size) };
  };
  return visit(root) ?? rootLayout();
}

/** Set the sizes of the split found at `path` (child indices from the root). */
export function setSizesAt(root: PaneNode, path: number[], sizes: number[]): PaneNode {
  if (path.length === 0) return root.kind === "split" ? { ...root, sizes } : root;
  if (root.kind !== "split") return root;
  const [head, ...rest] = path;
  return { ...root, children: root.children.map((c, i) => (i === head ? setSizesAt(c, rest, sizes) : c)) };
}

/** Which side of a pane rect the pointer is on (edges ~28%), else centre. */
export function sideAt(rect: DOMRect, x: number, y: number): DropSide | "center" {
  const fx = (x - rect.left) / rect.width;
  const fy = (y - rect.top) / rect.height;
  const edges: [DropSide, number][] = [
    ["left", fx],
    ["right", 1 - fx],
    ["top", fy],
    ["bottom", 1 - fy],
  ];
  const [side, dist] = edges.sort((a, b) => a[1] - b[1])[0];
  return dist < 0.28 ? side : "center";
}
