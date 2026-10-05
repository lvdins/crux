import { useEffect, useMemo, useRef, useState } from "react";
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCollide,
  forceX,
  forceY,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3-force";
import type { FeatureMapData } from "./FeatureMap";

/**
 * Dependency-galaxy view of the feature map: every feature, page, endpoint,
 * backend view and test file is a star; links are the evidence the scanner
 * found. Features that share endpoints or backend views get a direct link,
 * which is what makes clusters of related features visible.
 */

type Kind = "feature" | "page" | "endpoint" | "view" | "e2e" | "api";

interface GNode extends SimulationNodeDatum {
  id: string;
  kind: Kind;
  label: string;
  sub?: string;
  degree: number;
  tests: number; // test files linked (directly or through endpoints)
  gaps: number; // endpoints without API tests (features / endpoints)
  featureId?: string;
  r: number;
}
interface GLink extends SimulationLinkDatum<GNode> {
  source: GNode | string;
  target: GNode | string;
  kind: "own" | "serve" | "test" | "shared";
  weight: number;
}

const KIND_META: Record<Kind, { label: string; color: string }> = {
  feature: { label: "Features", color: "#ffffff" },
  page: { label: "Pages", color: "#f0d08e" },
  endpoint: { label: "Endpoints", color: "#c9a0e8" },
  view: { label: "Backend views", color: "#e8a0bf" },
  e2e: { label: "E2E tests", color: "#7ec98f" },
  api: { label: "API tests", color: "#6fa8dc" },
};
const SELECT = "#ff4040";

function buildGraph(data: FeatureMapData) {
  const nodes = new Map<string, GNode>();
  const links: GLink[] = [];
  const linkKeys = new Set<string>();
  const node = (id: string, kind: Kind, label: string, sub?: string): GNode => {
    let n = nodes.get(id);
    if (!n) {
      n = { id, kind, label, sub, degree: 0, tests: 0, gaps: 0, r: 2 };
      nodes.set(id, n);
    }
    return n;
  };
  const link = (a: GNode, b: GNode, kind: GLink["kind"], weight = 1) => {
    const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
    if (linkKeys.has(key)) return;
    linkKeys.add(key);
    links.push({ source: a.id, target: b.id, kind, weight });
    a.degree++;
    b.degree++;
  };

  // feature → owners of each shared endpoint / backend view
  const endpointOwners = new Map<string, string[]>();
  const viewOwners = new Map<string, string[]>();

  for (const f of data.features) {
    const fn = node(`f:${f.id}`, "feature", f.label, f.module);
    fn.featureId = f.id;
    fn.gaps = f.coverage.endpoints - f.coverage.apiCovered;
    fn.tests = f.e2e.length + f.api.length;
    for (const p of f.pages) link(fn, node(`p:${p.route}`, "page", p.route), "own");
    for (const e of f.endpoints) {
      const en = node(`e:${e.path}`, "endpoint", `/${e.path}`, e.methods.join(" ") || undefined);
      en.gaps = e.apiTests.length ? 0 : 1;
      en.tests = e.apiTests.length + e.e2eTests.length;
      link(fn, en, "own");
      (endpointOwners.get(e.path) ?? endpointOwners.set(e.path, []).get(e.path)!).push(f.id);
      if (e.backend) {
        const vid = `v:${e.backend.view}|${e.backend.file ?? ""}`;
        const vn = node(vid, "view", e.backend.view, e.backend.file);
        link(en, vn, "serve");
        const owners = viewOwners.get(vid) ?? viewOwners.set(vid, []).get(vid)!;
        if (!owners.includes(f.id)) owners.push(f.id);
      }
      for (const t of e.apiTests) link(en, node(`a:${t}`, "api", t.split("/").pop()!, t), "test");
    }
    for (const t of f.e2e) {
      const tn = node(`t:${t.file}`, "e2e", t.file.split("/").pop()!, t.file);
      // Route evidence attaches to the page; everything else to the feature.
      const pageHits = f.pages.filter((p) => p.e2e.includes(t.file));
      if (pageHits.length) for (const p of pageHits) link(tn, nodes.get(`p:${p.route}`)!, "test");
      else link(tn, fn, "test");
    }
  }

  // Direct feature ↔ feature links: shared endpoints and backend views.
  const shared = new Map<string, number>();
  const bump = (owners: string[]) => {
    for (let i = 0; i < owners.length; i++)
      for (let j = i + 1; j < owners.length; j++) {
        const key = [owners[i], owners[j]].sort().join("|");
        shared.set(key, (shared.get(key) ?? 0) + 1);
      }
  };
  for (const owners of endpointOwners.values()) bump(owners);
  for (const owners of viewOwners.values()) bump(owners);
  for (const [key, weight] of shared) {
    const [a, b] = key.split("|");
    link(nodes.get(`f:${a}`)!, nodes.get(`f:${b}`)!, "shared", weight);
  }

  // test counts for pages / views / test files = their degree in test links
  for (const n of nodes.values()) {
    if (n.kind === "page" || n.kind === "view") n.tests = 0;
    if (n.kind === "e2e" || n.kind === "api") n.tests = n.degree;
  }
  for (const l of links) {
    if (l.kind !== "test") continue;
    const a = nodes.get(l.source as string)!;
    const b = nodes.get(l.target as string)!;
    if (a.kind === "page") a.tests++;
    if (b.kind === "page") b.tests++;
  }
  for (const n of nodes.values()) {
    const base = n.kind === "feature" ? 4.5 : n.kind === "view" ? 2.4 : 1.7;
    n.r = Math.min(n.kind === "feature" ? 14 : 7, base + Math.sqrt(n.degree) * (n.kind === "feature" ? 0.9 : 0.45));
  }
  return { nodes: [...nodes.values()], links };
}

/** Shorter, readable label text (full text stays in search, tooltip, info box). */
function displayLabel(n: GNode): string {
  let t = n.label;
  if (n.kind === "endpoint") t = t.replace(/^\/gapi\/(dashboard|admin|processing)/, "…").replace(/\{\}/g, "{id}");
  return t.length > 44 ? t.slice(0, 42) + "…" : t;
}

interface LabelCtx {
  focus: string | null;
  sel: string | null;
  near: Set<string> | null;
  matches: Set<string>;
  visible: (n: GNode) => boolean;
  k: number;
  x: number;
  y: number;
  w: number;
  h: number;
  dpr: number;
}

const FONT_FEATURE = "600 12.5px -apple-system, BlinkMacSystemFont, system-ui, sans-serif";
const FONT_OTHER = "500 11.5px -apple-system, BlinkMacSystemFont, system-ui, sans-serif";
const widthCache = new Map<string, number>();

/**
 * Greedy collision-free labelling in screen space: candidates are ranked
 * (focus, its features, its other neighbours, search hits, features by
 * size, then — when zoomed in — everything on screen), each tries eight
 * spots around its star and is dropped if every spot overlaps a placed box.
 */
function makeLabelDrawer(nodes: GNode[]) {
  return (ctx: CanvasRenderingContext2D, c: LabelCtx) => {
    const { focus, sel, near, matches, visible, k, x, y, w, h, dpr } = c;
    const toScreen = (n: GNode) => ({ sx: n.x! * k + w / 2 + x, sy: n.y! * k + h / 2 + y });
    const onScreen = (sx: number, sy: number) => sx > -40 && sx < w + 40 && sy > -20 && sy < h + 20;

    const rank = (n: GNode): number => {
      if (n.id === focus) return 0;
      if (near?.has(n.id)) return n.kind === "feature" ? 1 : 2;
      if (focus) return -1; // nothing else is labelled while focused
      if (matches.size) return matches.has(n.id) ? 3 : -1;
      if (n.kind === "feature") return 4;
      if (k > 1.5 && (n.kind === "page" || n.kind === "view" || n.kind === "endpoint")) return 5;
      if (k > 2.4) return 6;
      return -1;
    };
    const candidates = nodes
      .filter((n) => n.x !== undefined && visible(n))
      .map((n) => ({ n, r: rank(n) }))
      .filter((c) => c.r >= 0)
      .sort((a, b) => a.r - b.r || b.n.degree - a.n.degree)
      .slice(0, 260);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const hits = (b: { x0: number; y0: number; x1: number; y1: number }) =>
      placed.some((p) => b.x0 < p.x1 && b.x1 > p.x0 && b.y0 < p.y1 && b.y1 > p.y0);

    // Reserve the stars of the focus neighbourhood so labels don't cover them.
    for (const { n } of candidates) {
      const { sx, sy } = toScreen(n);
      const rr = n.r * k + 2;
      placed.push({ x0: sx - rr, y0: sy - rr, x1: sx + rr, y1: sy + rr });
    }

    for (const { n, r } of candidates) {
      const { sx, sy } = toScreen(n);
      if (!onScreen(sx, sy)) continue;
      const text = displayLabel(n);
      const font = n.kind === "feature" || n.id === focus ? FONT_FEATURE : FONT_OTHER;
      const key = font + text;
      ctx.font = font;
      const tw = widthCache.get(key) ?? widthCache.set(key, ctx.measureText(text).width).get(key)!;
      const th = n.kind === "feature" ? 15 : 14;
      const gap = n.r * k + 5;
      const spots: [number, number][] = [
        [sx + gap, sy - th / 2],
        [sx - gap - tw, sy - th / 2],
        [sx - tw / 2, sy - gap - th],
        [sx - tw / 2, sy + gap],
        [sx + gap * 0.7, sy - gap * 0.7 - th],
        [sx + gap * 0.7, sy + gap * 0.7],
        [sx - gap * 0.7 - tw, sy + gap * 0.7],
        [sx - gap * 0.7 - tw, sy - gap * 0.7 - th],
      ];
      // The focused label always shows; others only where there's room.
      const spot = spots.find(([lx, ly]) => !hits({ x0: lx - 3, y0: ly - 1, x1: lx + tw + 3, y1: ly + th + 1 })) ?? (r === 0 ? spots[0] : null);
      if (!spot) continue;
      const [lx, ly] = spot;
      placed.push({ x0: lx - 3, y0: ly - 1, x1: lx + tw + 3, y1: ly + th + 1 });

      const color = n.id === sel ? "#ffd0d0" : n.kind === "feature" ? "#ffffff" : KIND_META[n.kind].color;
      if (n.id === focus) {
        ctx.fillStyle = n.id === sel ? "rgba(120,20,20,0.85)" : "rgba(20,20,20,0.9)";
        ctx.strokeStyle = n.id === sel ? "rgba(255,90,90,0.8)" : "rgba(255,255,255,0.25)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(lx - 6, ly - 2, tw + 12, th + 4, 5);
        ctx.fill();
        ctx.stroke();
      } else {
        // Dark halo keeps text legible over links and stars.
        ctx.strokeStyle = "rgba(5,5,5,0.92)";
        ctx.lineWidth = 4;
        ctx.strokeText(text, lx, ly + th / 2);
      }
      ctx.globalAlpha = r <= 2 || r === 3 ? 1 : n.kind === "feature" ? 0.95 : 0.8;
      ctx.fillStyle = color;
      ctx.fillText(text, lx, ly + th / 2);
      ctx.globalAlpha = 1;
    }
  };
}

const otherEnd = (l: GLink, id: string) => {
  const s = typeof l.source === "string" ? l.source : l.source.id;
  const t = typeof l.target === "string" ? l.target : l.target.id;
  return s === id ? t : t === id ? s : null;
};

export default function FeatureGraph({ data, onOpenFeature }: { data: FeatureMapData; onOpenFeature: (id: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const [hidden, setHidden] = useState<Set<Kind>>(() => new Set());
  const graph = useMemo(() => buildGraph(data), [data]);
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const neighbours = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const l of graph.links) {
      const s = typeof l.source === "string" ? l.source : l.source.id;
      const t = typeof l.target === "string" ? l.target : l.target.id;
      (map.get(s) ?? map.set(s, new Set()).get(s)!).add(t);
      (map.get(t) ?? map.set(t, new Set()).get(t)!).add(s);
    }
    return map;
  }, [graph]);

  // Mutable render state lives in a ref so the draw loop never re-subscribes.
  const view = useRef({ x: 0, y: 0, k: 0.55, w: 0, h: 0, dpr: 1 });
  const ui = useRef({ selected: null as string | null, hover: null as string | null, hidden: hidden, matches: new Set<string>(), dirty: true });
  const simRef = useRef<Simulation<GNode, GLink> | null>(null);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [] as GNode[];
    return graph.nodes
      .filter((n) => !hidden.has(n.kind) && `${n.label} ${n.sub ?? ""}`.toLowerCase().includes(q))
      .sort((a, b) => (a.kind === "feature" ? -1 : 0) - (b.kind === "feature" ? -1 : 0) || b.degree - a.degree);
  }, [query, graph, hidden]);

  useEffect(() => {
    ui.current.selected = selected;
    ui.current.hover = hover?.id ?? null;
    ui.current.hidden = hidden;
    ui.current.matches = new Set(matches.map((m) => m.id));
    ui.current.dirty = true;
  }, [selected, hover, hidden, matches]);

  // physics
  useEffect(() => {
    const kindRank: Record<Kind, number> = { feature: 0, page: 1, endpoint: 1, view: 2, e2e: 2, api: 3 };
    for (const n of graph.nodes) {
      if (n.x === undefined) {
        const a = Math.random() * Math.PI * 2;
        const rad = 120 + kindRank[n.kind] * 140 + Math.random() * 260;
        n.x = Math.cos(a) * rad;
        n.y = Math.sin(a) * rad;
      }
    }
    const sim = forceSimulation<GNode>(graph.nodes)
      .force(
        "link",
        forceLink<GNode, GLink>(graph.links)
          .id((n) => n.id)
          .distance((l) => (l.kind === "shared" ? 140 : l.kind === "own" ? 46 : l.kind === "serve" ? 30 : 38))
          .strength((l) => (l.kind === "shared" ? Math.min(0.25, 0.04 * l.weight) : 0.32)),
      )
      .force("charge", forceManyBody<GNode>().strength((n) => (n.kind === "feature" ? -260 : -14)).distanceMax(520))
      .force("collide", forceCollide<GNode>((n) => n.r + 1.2))
      .force("x", forceX<GNode>(0).strength(0.018))
      .force("y", forceY<GNode>(0).strength(0.018))
      .alphaDecay(0.022)
      .on("tick", () => {
        ui.current.dirty = true;
      });
    simRef.current = sim;
    return () => {
      sim.stop();
    };
  }, [graph]);

  // canvas sizing + draw loop
  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const ctx = canvas.getContext("2d")!;
    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      view.current.w = rect.width;
      view.current.h = rect.height;
      view.current.dpr = dpr;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      ui.current.dirty = true;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    let raf = 0;
    let pulse = 0;
    const drawLabels = makeLabelDrawer(graph.nodes);
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const { selected: sel, hover: hov, hidden: hid, matches: mt } = ui.current;
      pulse += 0.04;
      if (!ui.current.dirty && !sel) return;
      ui.current.dirty = false;
      const { x, y, k, w, h, dpr } = view.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#050505";
      ctx.fillRect(0, 0, w, h);
      ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * (w / 2 + x), dpr * (h / 2 + y));

      const focus = sel ?? hov;
      const near = focus ? neighbours.get(focus) ?? new Set<string>() : null;
      const visible = (n: GNode) => !hid.has(n.kind);

      // links
      ctx.lineWidth = 0.6 / k;
      for (const l of graph.links) {
        const s = l.source as GNode;
        const t = l.target as GNode;
        if (!visible(s) || !visible(t) || s.x === undefined || t.x === undefined) continue;
        const hot = focus && (s.id === focus || t.id === focus);
        if (focus && !hot) {
          ctx.strokeStyle = "rgba(255,255,255,0.025)";
        } else if (hot) {
          ctx.strokeStyle = l.kind === "shared" ? "rgba(255,90,90,0.85)" : "rgba(255,255,255,0.55)";
        } else {
          ctx.strokeStyle = l.kind === "shared" ? "rgba(255,140,170,0.22)" : "rgba(220,200,255,0.075)";
        }
        ctx.beginPath();
        ctx.moveTo(s.x, s.y!);
        ctx.lineTo(t.x, t.y!);
        ctx.stroke();
      }

      // nodes
      for (const n of graph.nodes) {
        if (!visible(n) || n.x === undefined) continue;
        const isFocus = n.id === focus;
        const isNear = near?.has(n.id);
        const isMatch = mt.has(n.id);
        let alpha = focus ? (isFocus || isNear ? 1 : 0.1) : mt.size ? (isMatch ? 1 : 0.25) : n.kind === "feature" ? 1 : 0.8;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = n.id === sel ? SELECT : KIND_META[n.kind].color;
        if (n.kind === "feature" && !focus) {
          ctx.shadowColor = "rgba(255,255,255,0.7)";
          ctx.shadowBlur = 10;
        }
        // Background stars shrink while something is focused.
        const faded = focus && !isFocus && !isNear;
        ctx.beginPath();
        ctx.arc(n.x, n.y!, faded ? Math.min(n.r, 2.2 / k) : n.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        if (isMatch && !focus) {
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 1 / k;
          ctx.beginPath();
          ctx.arc(n.x, n.y!, n.r + 3 / k, 0, Math.PI * 2);
          ctx.stroke();
        }
        alpha = 1;
      }
      ctx.globalAlpha = 1;

      // selection ring (the "steering" circle)
      if (sel) {
        const n = byId.get(sel);
        if (n?.x !== undefined) {
          const ring = 46 + Math.sin(pulse) * 3;
          ctx.strokeStyle = "rgba(255,255,255,0.55)";
          ctx.lineWidth = 1 / k;
          ctx.beginPath();
          ctx.arc(n.x, n.y!, ring / k, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      drawLabels(ctx, { focus, sel, near, matches: mt, visible, k, x, y, w, h, dpr });
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [graph, neighbours, byId]);

  // pointer: pan, zoom, drag nodes, hover, click
  useEffect(() => {
    const canvas = canvasRef.current!;
    const toWorld = (cx: number, cy: number) => {
      const rect = canvas.getBoundingClientRect();
      const { x, y, k, w, h } = view.current;
      return { wx: (cx - rect.left - w / 2 - x) / k, wy: (cy - rect.top - h / 2 - y) / k };
    };
    const pick = (cx: number, cy: number): GNode | null => {
      const { wx, wy } = toWorld(cx, cy);
      let best: GNode | null = null;
      let bestD = Infinity;
      for (const n of graph.nodes) {
        if (ui.current.hidden.has(n.kind) || n.x === undefined) continue;
        const d = Math.hypot(n.x - wx, n.y! - wy);
        const hit = n.r + 5 / view.current.k;
        if (d < hit && d < bestD) {
          best = n;
          bestD = d;
        }
      }
      return best;
    };

    let drag: null | { node: GNode | null; sx: number; sy: number; ox: number; oy: number; moved: boolean } = null;
    const down = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      const node = pick(e.clientX, e.clientY);
      drag = { node, sx: e.clientX, sy: e.clientY, ox: view.current.x, oy: view.current.y, moved: false };
      if (node) {
        node.fx = node.x;
        node.fy = node.y;
      }
    };
    const move = (e: PointerEvent) => {
      if (drag) {
        const dx = e.clientX - drag.sx;
        const dy = e.clientY - drag.sy;
        if (Math.hypot(dx, dy) > 3) drag.moved = true;
        if (drag.node) {
          const { wx, wy } = toWorld(e.clientX, e.clientY);
          drag.node.fx = wx;
          drag.node.fy = wy;
          simRef.current?.alphaTarget(0.15).restart();
        } else {
          view.current.x = drag.ox + dx;
          view.current.y = drag.oy + dy;
        }
        ui.current.dirty = true;
        return;
      }
      const n = pick(e.clientX, e.clientY);
      const rect = canvas.getBoundingClientRect();
      setHover(n ? { id: n.id, x: e.clientX - rect.left, y: e.clientY - rect.top } : null);
      canvas.style.cursor = n ? "pointer" : "grab";
    };
    const up = () => {
      if (!drag) return;
      if (drag.node) {
        drag.node.fx = null;
        drag.node.fy = null;
        simRef.current?.alphaTarget(0);
      }
      if (!drag.moved) setSelected(drag.node ? drag.node.id : null);
      drag = null;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const v = view.current;
      // Gentle, pointer-anchored zoom (trackpads send many small deltas).
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      const k = Math.min(4, Math.max(0.12, v.k * factor));
      const px = e.clientX - rect.left - v.w / 2;
      const py = e.clientY - rect.top - v.h / 2;
      v.x = px - ((px - v.x) * k) / v.k;
      v.y = py - ((py - v.y) * k) / v.k;
      v.k = k;
      ui.current.dirty = true;
    };
    const leave = () => setHover(null);
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointerleave", leave);
    canvas.addEventListener("wheel", wheel, { passive: false });
    return () => {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointerleave", leave);
      canvas.removeEventListener("wheel", wheel);
    };
  }, [graph]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Glide the camera to frame the selected star and its neighbours.
  useEffect(() => {
    if (!selected) return;
    const n = byId.get(selected);
    if (n?.x === undefined) return;
    const group = [n, ...[...(neighbours.get(selected) ?? [])].map((id) => byId.get(id)!).filter((m) => m?.x !== undefined && !hidden.has(m.kind))];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const m of group) {
      x0 = Math.min(x0, m.x!); y0 = Math.min(y0, m.y!);
      x1 = Math.max(x1, m.x!); y1 = Math.max(y1, m.y!);
    }
    const v = view.current;
    // Leave room for the search panel (left) and info box (bottom).
    const availW = Math.max(200, v.w - 360);
    const availH = Math.max(200, v.h - 240);
    const tk = Math.min(2.2, Math.max(0.35, Math.min(availW / Math.max(80, x1 - x0 + 220), availH / Math.max(80, y1 - y0 + 120))));
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const target = { x: -cx * tk + 150, y: -cy * tk - 50, k: tk };
    const from = { x: v.x, y: v.y, k: v.k };
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / 650);
      const e = 1 - Math.pow(1 - p, 3);
      v.x = from.x + (target.x - from.x) * e;
      v.y = from.y + (target.y - from.y) * e;
      v.k = from.k + (target.k - from.k) * e;
      ui.current.dirty = true;
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const focusNode = (id: string) => setSelected(id);

  const sel = selected ? byId.get(selected) : null;
  const selNear = sel ? [...(neighbours.get(sel.id) ?? [])].map((id) => byId.get(id)!).filter(Boolean) : [];
  const nearCounts = selNear.reduce<Record<string, number>>((acc, n) => ((acc[n.kind] = (acc[n.kind] ?? 0) + 1), acc), {});
  const hoverNode = hover ? byId.get(hover.id) : null;
  const counts = graph.nodes.reduce<Record<string, number>>((acc, n) => ((acc[n.kind] = (acc[n.kind] ?? 0) + 1), acc), {});

  return (
    <div className="fg" ref={wrapRef}>
      <canvas ref={canvasRef} />

      <div className="fg-search">
        <div className="fg-search-box">
          <input
            placeholder="Search features, endpoints, views, tests…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches[0]) focusNode(matches[0].id);
            }}
          />
          {query && (
            <button onClick={() => setQuery("")} title="Clear">
              ×
            </button>
          )}
        </div>
        {query && (
          <>
            <div className="fg-found">
              Found <b>{matches.length}</b> matches
            </div>
            <div className="fg-matches">
              {matches.slice(0, 200).map((n) => (
                <button key={n.id} className={selected === n.id ? "on" : ""} onClick={() => focusNode(n.id)}>
                  <span className="fg-kind-dot" style={{ background: KIND_META[n.kind].color }} />
                  <span className="fg-m-label">{n.label}</span>
                  <span className="fg-m-good">{n.tests}</span>
                  <span className="fg-m-bad">{n.gaps}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="fg-legend">
        {(Object.keys(KIND_META) as Kind[]).map((k) => (
          <button
            key={k}
            className={hidden.has(k) ? "off" : ""}
            onClick={() =>
              setHidden((h) => {
                const next = new Set(h);
                if (next.has(k)) next.delete(k);
                else next.add(k);
                return next;
              })
            }
          >
            <span className="fg-kind-dot" style={{ background: KIND_META[k].color }} />
            {KIND_META[k].label}
            <small>{counts[k] ?? 0}</small>
          </button>
        ))}
        <span className="fg-legend-shared">
          <i /> shared endpoint / view
        </span>
      </div>

      {hoverNode && hover && hoverNode.id !== selected && (
        <div className="fg-tip" style={{ left: hover.x + 14, top: hover.y - 10 }}>
          <span className="fg-tip-label">{hoverNode.label}</span>
          <span className="fg-m-good">{hoverNode.tests}</span>
          <span className="fg-m-bad">{hoverNode.gaps}</span>
        </div>
      )}

      {sel && (
        <div className="fg-info">
          <div className="fg-info-line">
            <span className="fg-kind-dot" style={{ background: KIND_META[sel.kind].color }} />
            <b>{sel.label}</b> has <b>{selNear.length}</b> connections
          </div>
          {sel.sub && <div className="fg-info-sub">{sel.sub}</div>}
          <div className="fg-info-box">
            <div>
              <span className="fg-big good">{sel.tests}</span>
              <small>{sel.kind === "e2e" || sel.kind === "api" ? "links" : "tests"}</small>
            </div>
            <div>
              <span className="fg-big bad">{sel.gaps}</span>
              <small>{sel.kind === "feature" ? "untested endpoints" : sel.kind === "endpoint" ? "no API test" : "gaps"}</small>
            </div>
          </div>
          <div className="fg-info-kinds">
            {(Object.keys(KIND_META) as Kind[])
              .filter((k) => nearCounts[k])
              .map((k) => (
                <span key={k}>
                  <span className="fg-kind-dot" style={{ background: KIND_META[k].color }} />
                  {nearCounts[k]} {KIND_META[k].label.toLowerCase()}
                </span>
              ))}
          </div>
          {sel.featureId && (
            <button className="fg-open" onClick={() => onOpenFeature(sel.featureId!)}>
              Open in coverage →
            </button>
          )}
        </div>
      )}

      <div className="fg-hint">Scroll to zoom · drag to pan · click a star to focus · Esc to clear</div>
    </div>
  );
}
