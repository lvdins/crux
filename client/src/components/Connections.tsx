import { useEffect, useMemo, useState } from "react";
import { api } from "../net";
import { usePanZoom } from "./usePanZoom";

/**
 * Three-hub web: Product Docs on top, E2E and API below. Edges show what is
 * actually connected — orange for shared API endpoints, green for shared
 * topics (name-token overlap between a docs section and a test dir).
 */

const W = 1400;
const H = 900;

interface HubNode {
  dir: string;
  label: string;
  files: number;
  tests?: number;
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
interface Data {
  nodes: Record<string, HubNode[]>;
  topicLinks: TopicLink[];
  endpointLinks: EndpointLink[];
}

const HUBS: Record<string, { cx: number; cy: number; label: string }> = {
  docs: { cx: W / 2, cy: 185, label: "Product Docs" },
  e2e: { cx: W * 0.21, cy: H - 235, label: "Playwright E2E" },
  api: { cx: W * 0.79, cy: H - 235, label: "API Quality" },
};
const HUB_R = 132;
const MAX_NODES = 12;

interface Positioned {
  x: number;
  y: number;
}

export default function Connections() {
  const [data, setData] = useState<Data | null>(null);
  const [minWeight, setMinWeight] = useState(2);
  const [selected, setSelected] = useState<string | null>(null);
  const { view, svgRef, zoomAt, reset, isPanning, handlers } = usePanZoom(W, H);

  useEffect(() => {
    api("/api/connections").then((r) => r.json()).then(setData);
  }, []);

  const graph = useMemo(() => {
    if (!data) return null;
    const topics = data.topicLinks.filter((l) => l.weight >= minWeight);

    // Rank each hub's dirs by how connected they are, keep the top slice.
    const score = new Map<string, number>();
    const bump = (repo: string, dir: string, n: number) => {
      const key = `${repo}:${dir}`;
      score.set(key, (score.get(key) ?? 0) + n);
    };
    for (const l of topics) {
      bump(l.from[0], l.from[1], l.weight);
      bump(l.to[0], l.to[1], l.weight);
    }
    for (const e of data.endpointLinks) {
      for (const d of e.e2e) bump("e2e", d, 3);
      for (const d of e.api) bump("api", d, 3);
    }

    const placed = new Map<string, Positioned & { node: HubNode; repo: string }>();
    for (const [repo, hub] of Object.entries(HUBS)) {
      const nodes = (data.nodes[repo] ?? [])
        .slice()
        .sort((a, b) => (score.get(`${repo}:${b.dir}`) ?? 0) - (score.get(`${repo}:${a.dir}`) ?? 0))
        .slice(0, MAX_NODES);
      nodes.forEach((node, i) => {
        const angle = (i / nodes.length) * Math.PI * 2 - Math.PI / 2;
        placed.set(`${repo}:${node.dir}`, {
          x: hub.cx + HUB_R * Math.cos(angle),
          y: hub.cy + HUB_R * Math.sin(angle),
          node,
          repo,
        });
      });
    }

    const topicEdges = topics.filter(
      (l) => placed.has(`${l.from[0]}:${l.from[1]}`) && placed.has(`${l.to[0]}:${l.to[1]}`),
    );
    const endpointEdges = data.endpointLinks
      .map((e) => ({
        ...e,
        pairs: e.e2e.flatMap((a) =>
          e.api
            .filter((b) => placed.has(`e2e:${a}`) && placed.has(`api:${b}`))
            .map((b) => [`e2e:${a}`, `api:${b}`] as const),
        ),
      }))
      .filter((e) => e.pairs.length > 0);

    return { placed, topicEdges, endpointEdges, hidden: topics.length - topicEdges.length };
  }, [data, minWeight]);

  if (!data || !graph) return <div className="tree"><p className="meta-line">Mapping connections…</p></div>;

  const { placed, topicEdges, endpointEdges } = graph;
  const touches = (key: string, l: TopicLink) =>
    `${l.from[0]}:${l.from[1]}` === key || `${l.to[0]}:${l.to[1]}` === key;
  const dimmed = (active: boolean) => (selected && !active ? "dim" : "");

  const curve = (a: Positioned, b: Positioned, sag = 0.18) => {
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2 - Math.abs(a.x - b.x) * sag - 20;
    return `M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`;
  };

  return (
    <div className="web-wrap">
      <div className="web-legend">
        <span><i className="swatch endpoint" /> shared endpoint</span>
        <span><i className="swatch topic" /> shared topic</span>
        <label>
          min overlap
          <select value={minWeight} onChange={(e) => setMinWeight(Number(e.target.value))}>
            {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <span className="faint-text">{topicEdges.length} topic · {endpointEdges.length} endpoint links</span>
      </div>
      <div className="web-controls">
        <button onClick={() => zoomAt(1 / 1.3)}>+</button>
        <button onClick={() => zoomAt(1.3)}>−</button>
        <button onClick={reset}>reset</button>
      </div>
      <svg
        ref={svgRef}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        className={`web-svg ${isPanning() ? "panning" : ""}`}
        preserveAspectRatio="xMidYMid meet"
        {...handlers}
        onClick={() => setSelected(null)}
      >
        {/* topic edges */}
        {topicEdges.map((l, i) => {
          const fromKey = `${l.from[0]}:${l.from[1]}`;
          const toKey = `${l.to[0]}:${l.to[1]}`;
          const a = placed.get(fromKey)!;
          const b = placed.get(toKey)!;
          const active = !selected || selected === fromKey || selected === toKey;
          return (
            <path
              key={`t${i}`}
              d={curve(a, b)}
              className={`conn-edge topic ${dimmed(active)}`}
              style={{ strokeWidth: 0.8 + Math.min(3, l.weight * 0.45) }}
            >
              <title>{`${l.from[1]} ↔ ${l.to[1]}\nshared: ${l.via.join(", ")}`}</title>
            </path>
          );
        })}
        {/* endpoint edges */}
        {endpointEdges.map((e, i) =>
          e.pairs.map(([fromKey, toKey], j) => {
            const a = placed.get(fromKey)!;
            const b = placed.get(toKey)!;
            const active = !selected || selected === fromKey || selected === toKey;
            return (
              <path key={`e${i}-${j}`} d={curve(a, b, 0.08)} className={`conn-edge endpoint ${dimmed(active)}`}>
                <title>{`${e.path}\n${fromKey.split(":")[1]} ↔ ${toKey.split(":")[1]}`}</title>
              </path>
            );
          }),
        )}
        {/* hubs */}
        {Object.entries(HUBS).map(([repo, hub]) => (
          <g key={repo}>
            <circle cx={hub.cx} cy={hub.cy} r={34} className="web-center" />
            <text x={hub.cx} y={hub.cy + 4} className="web-center-label" textAnchor="middle">
              {hub.label}
            </text>
          </g>
        ))}
        {/* dir nodes */}
        {[...placed.entries()].map(([key, p]) => {
          const hub = HUBS[p.repo];
          const outward = Math.atan2(p.y - hub.cy, p.x - hub.cx);
          const lp = { x: p.x + 14 * Math.cos(outward), y: p.y + 14 * Math.sin(outward) };
          const anchor = Math.cos(outward) > 0.35 ? "start" : Math.cos(outward) < -0.35 ? "end" : "middle";
          const active = !selected || selected === key ||
            topicEdges.some((l) => touches(key, l) && (touches(selected!, l))) ||
            endpointEdges.some((e) => e.pairs.some((pair) => pair.includes(key as never) && pair.includes(selected as never)));
          return (
            <g key={key} className={dimmed(active)}>
              <circle
                cx={p.x}
                cy={p.y}
                r={6 + Math.min(6, (p.node.tests ?? p.node.files) / 25)}
                className={`conn-node ${selected === key ? "selected" : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelected(selected === key ? null : key);
                }}
              >
                <title>{`${p.node.dir} — ${p.node.files} ${p.repo === "docs" ? "pages" : "files"}${p.node.tests != null ? `, ${p.node.tests} tests` : ""}\nclick to highlight its connections`}</title>
              </circle>
              <text
                x={lp.x}
                y={lp.y + (anchor === "middle" ? (Math.sin(outward) > 0 ? 12 : -6) : 4)}
                className="web-label"
                textAnchor={anchor}
              >
                {p.node.dir}
              </text>
            </g>
          );
        })}
      </svg>
      <p className="web-hint">click a node to isolate its connections · hover an edge for details · scroll to zoom, drag to pan</p>
    </div>
  );
}
