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
import { api } from "../net";

/**
 * How the dashboard's features connect: each bubble is a feature module
 * (sized by its files); a blue line means one feature uses the other's code,
 * an orange line means both work on the same backend data (Django models).
 * Click a bubble for its pages, backend data and every connection with why.
 */

interface GraphFeature {
  id: string;
  label: string;
  group: string;
  module: string;
  files: number;
  pages: string[];
  models: { name: string; area: string }[];
  common: string[];
  helper: boolean;
}
interface GraphLink {
  from: string;
  to: string;
  kind: "code" | "data";
  weight: number;
  why: string[];
}
interface GraphData {
  ready: boolean;
  missing: string[];
  features: GraphFeature[];
  links: GraphLink[];
  unused: string[];
  ms: number;
}

interface Node extends SimulationNodeDatum {
  f: GraphFeature;
  r: number;
}
interface Link extends SimulationLinkDatum<Node> {
  l: GraphLink;
}

type Kind = GraphLink["kind"];
const KIND: Record<Kind, { label: string; color: string; hot: string }> = {
  code: { label: "Uses code from", color: "rgba(122,167,255,0.22)", hot: "rgba(122,167,255,0.95)" },
  data: { label: "Shares backend data", color: "rgba(240,163,94,0.22)", hot: "rgba(240,163,94,0.95)" },
};
const GROUP_COLOR: Record<string, string> = { Dashboard: "#e9e9ee", Editors: "#c9a0e8" };

const idOf = (end: Node | string | number | undefined) => (typeof end === "object" ? end.f.id : String(end));

export default function FeatureNetwork({ refreshKey, onOpenFeature }: { refreshKey: number; onOpenFeature: (id: string) => void }) {
  const [data, setData] = useState<GraphData | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hidden, setHidden] = useState<Set<Kind>>(() => new Set());
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setError("");
    api(`/api/feature-graph${refreshKey ? "?refresh=1" : ""}`)
      .then((r) => r.json())
      .then((d: GraphData) => setData(d))
      .catch((err) => setError(String(err)));
  }, [refreshKey]);

  const graph = useMemo(() => {
    if (!data) return null;
    const nodes: Node[] = data.features.map((f) => ({ f, r: 7 + Math.sqrt(f.files) * 1.15 }));
    const byId = new Map(nodes.map((n) => [n.f.id, n]));
    const links: Link[] = data.links.filter((l) => byId.has(l.from) && byId.has(l.to)).map((l) => ({ source: l.from, target: l.to, l }));
    return { nodes, links, byId };
  }, [data]);

  // Best match first: name, then start of name, then pages / models.
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !data) return new Set<string>();
    const score = (f: GraphFeature) => {
      const name = f.label.toLowerCase();
      if (name === q || f.id === q) return 0;
      if (name.startsWith(q)) return 1;
      if (name.includes(q)) return 2;
      return `${f.module} ${f.pages.join(" ")} ${f.models.map((m) => m.name).join(" ")}`.toLowerCase().includes(q) ? 3 : -1;
    };
    return new Set(
      data.features
        .map((f) => ({ f, s: score(f) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => a.s - b.s || b.f.files - a.f.files)
        .map((x) => x.f.id),
    );
  }, [query, data]);

  // Render state the draw loop reads without re-subscribing.
  const ui = useRef({ selected: null as string | null, hover: null as string | null, hidden, matches, dirty: true });
  const view = useRef({ x: 0, y: 0, k: 0.55, w: 0, h: 0, dpr: 1 });
  const simRef = useRef<Simulation<Node, Link> | null>(null);
  useEffect(() => {
    Object.assign(ui.current, { selected, hover, hidden, matches, dirty: true });
  }, [selected, hover, hidden, matches]);

  // physics: strong links pull features into clusters
  useEffect(() => {
    if (!graph) return;
    // Features with no links (standalone pages) would be pushed to the edge: hold them close.
    const linked = new Set(graph.links.flatMap((l) => [l.l.from, l.l.to]));
    const pull = (k: number) => (n: Node) => (linked.has(n.f.id) ? k : 0.4);
    const sim = forceSimulation<Node>(graph.nodes)
      .force(
        "link",
        forceLink<Node, Link>(graph.links)
          .id((n) => n.f.id)
          .distance((l) => (l.l.kind === "code" ? 170 : 200) - Math.min(60, l.l.weight))
          .strength((l) => Math.min(0.35, 0.02 + 0.008 * l.l.weight)),
      )
      .force("charge", forceManyBody<Node>().strength(-900).distanceMax(900))
      .force("collide", forceCollide<Node>((n) => n.r + 34).strength(0.9))
      .force("x", forceX<Node>(0).strength(pull(0.035)))
      .force("y", forceY<Node>(0).strength(pull(0.05)))
      .on("tick", () => {
        ui.current.dirty = true;
      });
    simRef.current = sim;
    return () => {
      sim.stop();
    };
  }, [graph]);

  // neighbours of each feature (for focus highlighting)
  const near = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const l of data?.links ?? []) {
      (m.get(l.from) ?? m.set(l.from, new Set()).get(l.from)!).add(l.to);
      (m.get(l.to) ?? m.set(l.to, new Set()).get(l.to)!).add(l.from);
    }
    return m;
  }, [data]);

  // canvas + draw loop
  useEffect(() => {
    if (!graph) return;
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const ctx = canvas.getContext("2d")!;
    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      Object.assign(view.current, { w: rect.width, h: rect.height, dpr });
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
    const draw = () => {
      raf = requestAnimationFrame(draw);
      if (!ui.current.dirty) return;
      ui.current.dirty = false;
      const { selected: sel, hover: hov, hidden: hid, matches: mt } = ui.current;
      const { x, y, k, w, h, dpr } = view.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#121317";
      ctx.fillRect(0, 0, w, h);
      ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * (w / 2 + x), dpr * (h / 2 + y));
      const focus = sel ?? hov;
      const nb = focus ? near.get(focus) ?? new Set<string>() : null;

      for (const lk of graph.links) {
        if (hid.has(lk.l.kind)) continue;
        const s = lk.source as Node;
        const t = lk.target as Node;
        if (s.x === undefined || t.x === undefined) continue;
        const hot = !!focus && (s.f.id === focus || t.f.id === focus);
        ctx.strokeStyle = hot ? KIND[lk.l.kind].hot : focus ? "rgba(255,255,255,0.03)" : KIND[lk.l.kind].color;
        ctx.lineWidth = (hot ? 1.2 : 0.8) + Math.min(5, Math.sqrt(lk.l.weight) * (lk.l.kind === "code" ? 0.45 : 0.9));
        ctx.beginPath();
        if (lk.l.kind === "data") ctx.setLineDash([6, 5]);
        ctx.moveTo(s.x, s.y!);
        ctx.lineTo(t.x, t.y!);
        ctx.stroke();
        ctx.setLineDash([]);
        // arrowhead: "from uses to"
        if (lk.l.kind === "code" && (hot || !focus)) {
          const a = Math.atan2(t.y! - s.y!, t.x - s.x);
          const ex = t.x - Math.cos(a) * (t.r + 3);
          const ey = t.y! - Math.sin(a) * (t.r + 3);
          ctx.fillStyle = ctx.strokeStyle;
          ctx.beginPath();
          ctx.moveTo(ex, ey);
          ctx.lineTo(ex - Math.cos(a - 0.4) * 9, ey - Math.sin(a - 0.4) * 9);
          ctx.lineTo(ex - Math.cos(a + 0.4) * 9, ey - Math.sin(a + 0.4) * 9);
          ctx.fill();
        }
      }

      // Labels stay 12px on screen at any zoom.
      ctx.font = `600 ${12 / k}px -apple-system, BlinkMacSystemFont, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (const n of graph.nodes) {
        if (n.x === undefined) continue;
        const id = n.f.id;
        const lit = !focus || id === focus || nb!.has(id);
        const dim = (focus && !lit) || (mt.size > 0 && !mt.has(id) && !focus);
        ctx.globalAlpha = dim ? 0.18 : 1;
        ctx.fillStyle = id === sel ? "#ff5a5a" : GROUP_COLOR[n.f.group] ?? "#e9e9ee";
        ctx.beginPath();
        ctx.arc(n.x, n.y!, n.r, 0, Math.PI * 2);
        ctx.fill();
        if (mt.has(id) || id === focus) {
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(n.x, n.y!, n.r + 4, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.lineWidth = 4 / k;
        ctx.strokeStyle = "rgba(18,19,23,0.9)";
        ctx.strokeText(n.f.label, n.x, n.y! + n.r + 4 / k);
        ctx.fillStyle = id === sel ? "#ffd0d0" : "#fff";
        ctx.fillText(n.f.label, n.x, n.y! + n.r + 4 / k);
      }
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [graph, near]);

  // pointer: pan, zoom, drag bubbles, hover, click
  useEffect(() => {
    if (!graph) return;
    const canvas = canvasRef.current!;
    const toWorld = (cx: number, cy: number) => {
      const rect = canvas.getBoundingClientRect();
      const { x, y, k, w, h } = view.current;
      return { wx: (cx - rect.left - w / 2 - x) / k, wy: (cy - rect.top - h / 2 - y) / k };
    };
    const pick = (cx: number, cy: number) => {
      const { wx, wy } = toWorld(cx, cy);
      return graph.nodes.find((n) => n.x !== undefined && Math.hypot(n.x - wx, n.y! - wy) < n.r + 4) ?? null;
    };
    let drag: null | { node: Node | null; sx: number; sy: number; ox: number; oy: number; moved: boolean } = null;
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
          simRef.current?.alphaTarget(0.2).restart();
        } else {
          view.current.x = drag.ox + dx;
          view.current.y = drag.oy + dy;
        }
        ui.current.dirty = true;
        return;
      }
      const n = pick(e.clientX, e.clientY);
      setHover(n?.f.id ?? null);
      canvas.style.cursor = n ? "pointer" : "grab";
    };
    const up = () => {
      if (!drag) return;
      if (drag.node) {
        drag.node.fx = null;
        drag.node.fy = null;
        simRef.current?.alphaTarget(0);
      }
      if (!drag.moved) setSelected(drag.node?.f.id ?? null);
      drag = null;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const v = view.current;
      const k = Math.min(3, Math.max(0.2, v.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))));
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
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSelected(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (error) return <div className="fn-msg">Couldn't build the graph: {error}</div>;
  if (!data || !graph) return <div className="fn-msg">Reading the dashboard and backend…</div>;
  if (!data.ready) return <div className="fn-msg">Add the dashboard (frontend) repo as a workspace to see how its features connect.</div>;

  const f = selected ? graph.byId.get(selected)?.f : null;
  const label = (id: string) => graph.byId.get(id)?.f.label ?? id;
  const mine = f ? data.links.filter((l) => l.from === f.id || l.to === f.id) : [];
  const usesCode = mine.filter((l) => l.kind === "code" && l.from === f?.id).sort((a, b) => b.weight - a.weight);
  const usedBy = mine.filter((l) => l.kind === "code" && l.to === f?.id).sort((a, b) => b.weight - a.weight);
  const sharesData = mine.filter((l) => l.kind === "data").sort((a, b) => b.weight - a.weight);
  const areas = f ? [...new Set(f.models.map((m) => m.area))].sort() : [];
  const counts = { code: data.links.filter((l) => l.kind === "code").length, data: data.links.filter((l) => l.kind === "data").length };

  const Neighbour = ({ l, other, note }: { l: GraphLink; other: string; note: string }) => (
    <button className="fn-nb" onClick={() => setSelected(other)} title={l.why.join("\n")}>
      <span className="fn-nb-name">{label(other)}</span>
      <span className="fn-nb-why">{note}</span>
    </button>
  );

  return (
    <div className="fg fn" ref={wrapRef}>
      <canvas ref={canvasRef} />

      <div className="fg-search">
        <div className="fg-search-box">
          <input
            placeholder="Find a feature, page or backend model…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches.size) setSelected([...matches][0]);
            }}
          />
          {query && (
            <button onClick={() => setQuery("")} title="Clear">
              ×
            </button>
          )}
        </div>
        {query && <div className="fg-found">{matches.size} found · Enter to open</div>}
      </div>

      <div className="fg-legend">
        {(Object.keys(KIND) as Kind[]).map((k) => (
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
            <span className={`fn-line ${k}`} />
            {KIND[k].label}
            <small>{counts[k]}</small>
          </button>
        ))}
        <span className="fn-legend-note">
          <span className="fg-kind-dot" style={{ background: GROUP_COLOR.Dashboard }} /> Dashboard
          <span className="fg-kind-dot" style={{ background: GROUP_COLOR.Editors }} /> Editors
          {data.unused.length > 0 && (
            <span className="fn-unused" title={`Modules nothing imports, with no pages or data: ${data.unused.join(", ")}`}>
              · {data.unused.length} unused hidden
            </span>
          )}
        </span>
      </div>

      {hover && hover !== selected && graph.byId.get(hover) && (
        <div className="fn-tip">
          {label(hover)} · {near.get(hover)?.size ?? 0} connections
        </div>
      )}

      {f && (
        <aside className="fn-panel">
          <div className="fn-head">
            <div>
              <b>{f.label}</b>
              <span>
                {f.module} · {f.files} files{f.helper && " · shared helper, no pages of its own"}
              </span>
            </div>
            <button className="fn-x" onClick={() => setSelected(null)} title="Close (Esc)">
              ×
            </button>
          </div>

          {f.pages.length > 0 && (
            <section>
              <h4>Pages</h4>
              <div className="fn-chips">
                {f.pages.slice(0, 12).map((p) => (
                  <code key={p}>{p}</code>
                ))}
                {f.pages.length > 12 && <small>+{f.pages.length - 12} more</small>}
              </div>
            </section>
          )}

          <section>
            <h4>Backend data</h4>
            {f.models.length ? (
              <div className="fn-areas">
                {areas.map((a) => (
                  <div key={a}>
                    <span>{a || "Other"}</span>
                    <p>{f.models.filter((m) => m.area === a).map((m) => m.name).join(", ")}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="fn-none">No backend models found for its API calls.</p>
            )}
            {f.common.length > 0 && <p className="fn-none">Also uses {f.common.join(", ")} (nearly every feature does)</p>}
          </section>

          {sharesData.length > 0 && (
            <section>
              <h4 className="data">Shares backend data with · {sharesData.length}</h4>
              {sharesData.map((l) => {
                const other = l.from === f.id ? l.to : l.from;
                return <Neighbour key={other} l={l} other={other} note={l.why.join(", ")} />;
              })}
            </section>
          )}
          {usesCode.length > 0 && (
            <section>
              <h4 className="code">Uses code from · {usesCode.length}</h4>
              {usesCode.map((l) => (
                <Neighbour key={l.to} l={l} other={l.to} note={`${l.weight} import${l.weight === 1 ? "" : "s"} · ${l.why[0]}`} />
              ))}
            </section>
          )}
          {usedBy.length > 0 && (
            <section>
              <h4 className="code">Used by · {usedBy.length}</h4>
              {usedBy.map((l) => (
                <Neighbour key={l.from} l={l} other={l.from} note={`${l.weight} import${l.weight === 1 ? "" : "s"} · ${l.why[0]}`} />
              ))}
            </section>
          )}
          {!mine.length && <p className="fn-none">Not connected to other features.</p>}

          <button className="fg-open" onClick={() => onOpenFeature(f.id)}>
            Open in coverage →
          </button>
        </aside>
      )}

      <div className="fg-hint">Scroll to zoom · drag to pan · click a feature · Esc to clear</div>
    </div>
  );
}
