import { useEffect, useMemo, useRef, useState } from "react";
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCollide,
  forceX,
  forceY,
  type Simulation,
} from "d3-force";
import { api } from "../net";

/**
 * Obsidian-style graph of the whole QA surface: every docs page and test file
 * is a node, clustered around its folder hub by the physics; folder hubs are
 * linked across repos by shared endpoints (orange) and shared topics (green).
 * Canvas-rendered with pan/zoom, hover-highlighting and draggable nodes.
 */

interface HubNode {
  dir: string;
  label: string;
  files: number;
  tests?: number;
  items?: string[];
}
interface TopicLink {
  from: [string, string];
  to: [string, string];
  via: string[];
  weight: number;
}
interface EndpointLink {
  path: string;
  e2e: string[];
  api: string[];
}
interface FeatureLink {
  key: string;
  label: string;
  description: string;
  e2e: string[];
  api: string[];
}
interface Data {
  nodes: Record<string, HubNode[]>;
  topicLinks: TopicLink[];
  endpointLinks: EndpointLink[];
  featureLinks: FeatureLink[];
}

interface GNode {
  id: string;
  repo: string;
  label: string;
  kind: "hub" | "item";
  r: number;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
}
interface GEdge {
  source: string | GNode;
  target: string | GNode;
  kind: "member" | "topic" | "endpoint" | "feature";
  title?: string;
}

const REPO_COLORS: Record<string, string> = {
  e2e: "#7ec98f",
  api: "#6fa8dc",
};
const HUB_COLOR = "#a88bfa";
const REPO_LABELS: Record<string, string> = { e2e: "Playwright E2E", api: "API Quality" };

function shortName(p: string): string {
  const base = p.split("/").pop() ?? p;
  return base.replace(/\.(spec|setup)\.ts$|\.py$|\.md$/, "");
}

export default function Connections() {
  const [data, setData] = useState<Data | null>(null);
  const [minWeight, setMinWeight] = useState(2);
  const [showRepo, setShowRepo] = useState<Record<string, boolean>>({ e2e: true, api: true });
  const [showLabels, setShowLabels] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<Simulation<GNode, GEdge> | null>(null);
  const stateRef = useRef({
    nodes: [] as GNode[],
    edges: [] as GEdge[],
    transform: { k: 1, tx: 0, ty: 0 },
    hovered: null as GNode | null,
    neighbors: new Set<string>(),
    dragNode: null as GNode | null,
    panning: false,
    px: 0,
    py: 0,
  });

  useEffect(() => {
    api("/api/connections").then((r) => r.json()).then(setData);
  }, []);

  const graph = useMemo(() => {
    if (!data) return null;
    const nodes: GNode[] = [];
    const edges: GEdge[] = [];
    const hubId = (repo: string, dir: string) => `${repo}:${dir}`;

    for (const [repo, hubs] of Object.entries(data.nodes)) {
      if (!showRepo[repo]) continue;
      for (const hub of hubs) {
        const degree = hub.items?.length ?? 1;
        nodes.push({
          id: hubId(repo, hub.dir),
          repo,
          label: hub.dir,
          kind: "hub",
          r: Math.min(13, 5.5 + Math.sqrt(degree) * 0.9),
        });
        for (const item of hub.items ?? []) {
          const id = `${repo}:${hub.dir}:${item}`;
          nodes.push({ id, repo, label: shortName(item), kind: "item", r: 2.6 });
          edges.push({ source: id, target: hubId(repo, hub.dir), kind: "member" });
        }
      }
    }
    const have = new Set(nodes.map((n) => n.id));
    for (const l of data.topicLinks) {
      if (l.weight < minWeight) continue;
      const a = hubId(l.from[0], l.from[1]);
      const b = hubId(l.to[0], l.to[1]);
      if (have.has(a) && have.has(b)) {
        edges.push({ source: a, target: b, kind: "topic", title: l.via.join(", ") });
      }
    }
    for (const e of data.endpointLinks) {
      for (const dirA of e.e2e) {
        for (const dirB of e.api) {
          const a = hubId("e2e", dirA);
          const b = hubId("api", dirB);
          if (have.has(a) && have.has(b)) edges.push({ source: a, target: b, kind: "endpoint", title: e.path });
        }
      }
    }
    // feature links: derived from the product docs (qualitylab.features.json)
    for (const f of data.featureLinks ?? []) {
      for (const dirA of f.e2e) {
        for (const dirB of f.api) {
          const a = hubId("e2e", dirA);
          const b = hubId("api", dirB);
          if (have.has(a) && have.has(b)) {
            edges.push({ source: a, target: b, kind: "feature", title: `${f.label} — ${f.description}` });
          }
        }
      }
    }
    return { nodes, edges };
  }, [data, minWeight, showRepo]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !graph) return;
    const state = stateRef.current;
    state.nodes = graph.nodes.map((n) => ({ ...n }));
    state.edges = graph.edges.map((e) => ({ ...e }));

    const sim = forceSimulation<GNode>(state.nodes)
      .force(
        "link",
        forceLink<GNode, GEdge>(state.edges)
          .id((d) => d.id)
          .distance((e) => (e.kind === "member" ? 26 : e.kind === "feature" ? 130 : e.kind === "endpoint" ? 150 : 120))
          .strength((e) => (e.kind === "member" ? 0.7 : e.kind === "feature" ? 0.3 : 0.25)),
      )
      .force("charge", forceManyBody<GNode>().strength((d) => (d.kind === "hub" ? -160 : -14)).theta(0.9))
      .force("collide", forceCollide<GNode>((d) => d.r + 2))
      .force("x", forceX(0).strength(0.045))
      .force("y", forceY(0).strength(0.045))
      .alpha(1)
      .alphaDecay(0.015);
    simRef.current = sim;

    const adjacency = new Map<string, Set<string>>();
    for (const e of state.edges) {
      const s = typeof e.source === "string" ? e.source : e.source.id;
      const t = typeof e.target === "string" ? e.target : e.target.id;
      (adjacency.get(s) ?? adjacency.set(s, new Set()).get(s)!).add(t);
      (adjacency.get(t) ?? adjacency.set(t, new Set()).get(t)!).add(s);
    }

    const css = getComputedStyle(document.documentElement);
    const edgeColor = { member: "#2c2c2c", topic: "#2f5c43", endpoint: "#7a5a33", feature: "#5d4e96" };
    const edgeHi = {
      member: "#555555",
      topic: css.getPropertyValue("--accent").trim() || "#3ecf8e",
      endpoint: "#d9a05b",
      feature: "#a88bfa",
    };

    let raf = 0;
    const render = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== rect.width * dpr) {
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
      }
      const ctx = canvas.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      const { k, tx, ty } = state.transform;
      ctx.translate(rect.width / 2 + tx, rect.height / 2 + ty);
      ctx.scale(k, k);

      const hovered = state.hovered;
      const dimming = !!hovered;

      for (const e of state.edges) {
        const s = e.source as GNode;
        const t = e.target as GNode;
        if (s.x == null || t.x == null) continue;
        const active = hovered && (s.id === hovered.id || t.id === hovered.id);
        ctx.strokeStyle = active ? edgeHi[e.kind] : edgeColor[e.kind];
        ctx.globalAlpha = dimming && !active ? 0.12 : e.kind === "member" ? 0.7 : 0.9;
        ctx.lineWidth = (e.kind === "member" ? 0.5 : active ? 1.6 : 1.1) / k;
        ctx.beginPath();
        ctx.moveTo(s.x!, s.y!);
        ctx.lineTo(t.x!, t.y!);
        ctx.stroke();
      }

      for (const n of state.nodes) {
        if (n.x == null) continue;
        const isNeighbor = hovered && (n.id === hovered.id || state.neighbors.has(n.id));
        ctx.globalAlpha = dimming && !isNeighbor ? 0.18 : 1;
        ctx.fillStyle = n.kind === "hub" ? HUB_COLOR : REPO_COLORS[n.repo] ?? "#999";
        ctx.beginPath();
        ctx.arc(n.x!, n.y!, n.r, 0, Math.PI * 2);
        ctx.fill();
        const labelVisible =
          (hovered && isNeighbor) ||
          (showLabels && (n.kind === "hub" ? k > 0.55 : k > 2.1));
        if (labelVisible) {
          ctx.globalAlpha = dimming && !isNeighbor ? 0.15 : n.kind === "hub" ? 0.95 : 0.75;
          ctx.fillStyle = "#bdbdbd";
          ctx.font = `${(n.kind === "hub" ? 11 : 9) / k}px -apple-system, sans-serif`;
          ctx.textAlign = "center";
          ctx.fillText(n.label, n.x!, n.y! + n.r + 11 / k);
        }
      }
      ctx.globalAlpha = 1;
    };

    sim.on("tick", () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(render);
    });

    /* ---- interaction ---- */
    const toWorld = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      const { k, tx, ty } = state.transform;
      return {
        x: (clientX - rect.left - rect.width / 2 - tx) / k,
        y: (clientY - rect.top - rect.height / 2 - ty) / k,
      };
    };
    const pick = (clientX: number, clientY: number): GNode | null => {
      const p = toWorld(clientX, clientY);
      let best: GNode | null = null;
      let bestDist = Infinity;
      for (const n of state.nodes) {
        if (n.x == null) continue;
        const d = Math.hypot(n.x - p.x, n.y! - p.y);
        if (d < Math.max(n.r + 3, 6 / state.transform.k) && d < bestDist) {
          best = n;
          bestDist = d;
        }
      }
      return best;
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const factor = Math.exp(-Math.max(-80, Math.min(80, e.deltaY)) * 0.0012);
      const { k, tx, ty } = state.transform;
      const nk = Math.min(8, Math.max(0.15, k * factor));
      const mx = e.clientX - rect.left - rect.width / 2;
      const my = e.clientY - rect.top - rect.height / 2;
      state.transform = { k: nk, tx: mx - ((mx - tx) * nk) / k, ty: my - ((my - ty) * nk) / k };
      render();
    };
    const onPointerDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      const node = pick(e.clientX, e.clientY);
      if (node) {
        state.dragNode = node;
        node.fx = node.x;
        node.fy = node.y;
        sim.alphaTarget(0.25).restart();
      } else {
        state.panning = true;
      }
      state.px = e.clientX;
      state.py = e.clientY;
    };
    const onPointerMove = (e: PointerEvent) => {
      if (state.dragNode) {
        const p = toWorld(e.clientX, e.clientY);
        state.dragNode.fx = p.x;
        state.dragNode.fy = p.y;
      } else if (state.panning) {
        state.transform.tx += e.clientX - state.px;
        state.transform.ty += e.clientY - state.py;
        state.px = e.clientX;
        state.py = e.clientY;
        render();
      } else {
        const node = pick(e.clientX, e.clientY);
        if (node !== state.hovered) {
          state.hovered = node;
          state.neighbors = node ? adjacency.get(node.id) ?? new Set() : new Set();
          canvas.style.cursor = node ? "pointer" : "grab";
          render();
        }
      }
    };
    const onPointerUp = () => {
      if (state.dragNode) {
        state.dragNode.fx = null;
        state.dragNode.fy = null;
        state.dragNode = null;
        sim.alphaTarget(0);
      }
      state.panning = false;
    };

    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointerleave", onPointerUp);
    const observer = new ResizeObserver(render);
    observer.observe(canvas);

    return () => {
      sim.stop();
      cancelAnimationFrame(raf);
      observer.disconnect();
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointerleave", onPointerUp);
    };
  }, [graph, showLabels]);

  if (!data) return <div className="tree"><p className="meta-line">Mapping connections…</p></div>;

  const counts = graph ? `${graph.nodes.length} nodes · ${graph.edges.length} links` : "";

  return (
    <div className="graph-wrap">
      <canvas ref={canvasRef} className="graph-canvas" />
      <div className="graph-panel">
        <h4>Filters</h4>
        <div className="graph-section">
          <span className="graph-section-title">Groups</span>
          {Object.entries(REPO_LABELS).map(([key, label]) => (
            <label key={key} className="graph-row">
              <input
                type="checkbox"
                checked={showRepo[key]}
                onChange={(e) => setShowRepo((prev) => ({ ...prev, [key]: e.target.checked }))}
              />
              <i className="graph-dot" style={{ background: REPO_COLORS[key] }} />
              {label}
            </label>
          ))}
          <div className="graph-row static">
            <i className="graph-dot" style={{ background: HUB_COLOR }} /> folder hubs
          </div>
        </div>
        <div className="graph-section">
          <span className="graph-section-title">Links</span>
          <div className="graph-row static"><i className="graph-swatch" style={{ background: "#a88bfa" }} /> feature (from docs)</div>
          <div className="graph-row static"><i className="graph-swatch" style={{ background: "#d9a05b" }} /> shared endpoint</div>
          <div className="graph-row static"><i className="graph-swatch" style={{ background: "#3ecf8e" }} /> shared topic</div>
          <label className="graph-row">
            min topic overlap
            <select value={minWeight} onChange={(e) => setMinWeight(Number(e.target.value))}>
              {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        </div>
        <div className="graph-section">
          <span className="graph-section-title">Display</span>
          <label className="graph-row">
            <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} />
            labels
          </label>
          <button
            className="graph-reset"
            onClick={() => {
              stateRef.current.transform = { k: 1, tx: 0, ty: 0 };
              simRef.current?.alpha(0.5).restart();
            }}
          >
            reset view
          </button>
        </div>
        <div className="graph-counts">{counts}</div>
      </div>
      <p className="web-hint">hover to highlight a neighborhood · drag nodes · scroll to zoom · drag background to pan</p>
    </div>
  );
}
