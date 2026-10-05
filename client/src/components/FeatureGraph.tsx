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
        let alpha = focus ? (isFocus || isNear ? 1 : 0.18) : mt.size ? (isMatch ? 1 : 0.25) : n.kind === "feature" ? 1 : 0.8;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = n.id === sel ? SELECT : KIND_META[n.kind].color;
        if (n.kind === "feature" && !focus) {
          ctx.shadowColor = "rgba(255,255,255,0.7)";
          ctx.shadowBlur = 10;
        }
        ctx.beginPath();
        ctx.arc(n.x, n.y!, n.r, 0, Math.PI * 2);
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

      // labels: features always (when zoomed in enough), focus neighbourhood
      ctx.font = `${11 / k}px -apple-system, system-ui, sans-serif`;
      ctx.textBaseline = "middle";
      for (const n of graph.nodes) {
        if (!visible(n) || n.x === undefined) continue;
        const show =
          n.id === focus ||
          (near?.has(n.id) && (n.kind === "feature" || near.size < 40)) ||
          (!focus && n.kind === "feature" && k > 0.42) ||
          (!focus && mt.has(n.id) && mt.size < 30);
        if (!show) continue;
        ctx.globalAlpha = focus && n.id !== focus && !near?.has(n.id) ? 0.3 : n.kind === "feature" ? 0.92 : 0.75;
        ctx.fillStyle = n.id === sel ? "#ffb3b3" : n.kind === "feature" ? "#ffffff" : KIND_META[n.kind].color;
        ctx.fillText(n.label.length > 48 ? n.label.slice(0, 46) + "…" : n.label, n.x + n.r + 4 / k, n.y!);
      }
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

  const focusNode = (id: string) => {
    const n = byId.get(id);
    setSelected(id);
    if (n?.x !== undefined) {
      const v = view.current;
      v.k = Math.max(v.k, 0.9);
      v.x = -n.x * v.k;
      v.y = -n.y! * v.k;
      ui.current.dirty = true;
    }
  };

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
