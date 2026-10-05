import { useEffect, useMemo, useRef, useState } from "react";
import type { TreeResponse, RepoTree } from "../types";
import { api } from "../net";

/**
 * Radial "spider web" of a test suite: repo at the center, directories as the
 * first ring, files fanned out when a directory is expanded. In global mode
 * two suites face each other and shared endpoints bridge them in the middle.
 */

const W = 1200;
const H = 800;

interface DirGroup {
  name: string;
  files: { path: string; tests: number; endpoints: string[] }[];
  tests: number;
}

function groupDirs(tree: RepoTree): DirGroup[] {
  const map = new Map<string, DirGroup>();
  for (const f of tree.files) {
    const segments = f.path.split("/");
    const dir = segments.slice(0, Math.min(2, segments.length - 1)).join("/") || "(root)";
    const g = map.get(dir) ?? { name: dir, files: [], tests: 0 };
    g.files.push({ path: f.path, tests: f.tests.length, endpoints: f.endpoints });
    g.tests += f.tests.length;
    map.set(dir, g);
  }
  const groups = [...map.values()].sort((a, b) => b.tests - a.tests);
  if (groups.length > 24) {
    const rest = groups.slice(23);
    return [
      ...groups.slice(0, 23),
      {
        name: `… ${rest.length} more dirs`,
        files: [],
        tests: rest.reduce((n, g) => n + g.tests, 0),
      },
    ];
  }
  return groups;
}

function fileLabel(p: string): string {
  const base = p.split("/").pop() ?? p;
  return base.replace(/\.(spec|setup)\.ts$|\.py$/, "");
}

interface Positioned {
  x: number;
  y: number;
}

function polar(cx: number, cy: number, r: number, angle: number): Positioned {
  return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
}

function RepoWeb({
  tree,
  cx,
  cy,
  scale,
  expanded,
  toggle,
  dirPos,
}: {
  tree: RepoTree;
  cx: number;
  cy: number;
  scale: number;
  expanded: Set<string>;
  toggle: (key: string) => void;
  dirPos: Map<string, Positioned>;
}) {
  const dirs = useMemo(() => groupDirs(tree), [tree]);
  const total = tree.files.reduce((n, f) => n + f.tests.length, 0);
  // Ring radius grows with node count so directory nodes never crowd:
  // ~55px of circumference per node, floor of 170.
  const R1 = Math.max(170, (dirs.length * 55) / (2 * Math.PI)) * scale;
  const FILE_GAP = 95 * scale;

  return (
    <g>
      {[0.5, 0.75, 1].map((m) => (
        <circle key={m} cx={cx} cy={cy} r={R1 * m} className="web-ring" />
      ))}
      {dirs.map((dir, i) => {
        const angle = (i / dirs.length) * Math.PI * 2 - Math.PI / 2;
        const p = polar(cx, cy, R1, angle);
        const key = `${tree.key}:${dir.name}`;
        dirPos.set(key, p);
        const isOpen = expanded.has(key);
        const size = Math.max(6, Math.min(15, 4 + Math.sqrt(dir.tests) * 1.4)) * scale;
        const shown = dir.files.slice(0, 14);
        // Directory labels sit radially outside the node; anchor flips by side.
        const lp = polar(cx, cy, R1 + size + 10, angle);
        const anchor = Math.cos(angle) > 0.35 ? "start" : Math.cos(angle) < -0.35 ? "end" : "middle";
        const labelDy = Math.abs(Math.cos(angle)) <= 0.35 ? (Math.sin(angle) > 0 ? 12 : -6) : 4;
        return (
          <g key={dir.name}>
            <line x1={cx} y1={cy} x2={p.x} y2={p.y} className="web-edge" />
            {isOpen &&
              shown.map((f, j) => {
                // Files fan outward from their directory along its spoke,
                // staggered across two radii so labels don't collide.
                const spread = Math.min(Math.PI / 3.2, 0.11 * shown.length);
                const t = shown.length === 1 ? 0.5 : j / (shown.length - 1);
                const fa = angle - spread / 2 + spread * t;
                const fr = R1 + FILE_GAP + (j % 2) * 44 * scale;
                const fp = polar(cx, cy, fr, fa);
                const fAnchor = Math.cos(fa) > 0.2 ? "start" : Math.cos(fa) < -0.2 ? "end" : "middle";
                return (
                  <g key={f.path}>
                    <line x1={p.x} y1={p.y} x2={fp.x} y2={fp.y} className="web-edge faint" />
                    <circle cx={fp.x} cy={fp.y} r={3 * scale + Math.min(4, f.tests / 5)} className="web-file">
                      <title>{`${f.path} — ${f.tests} tests${f.endpoints.length ? `\n${f.endpoints.join("\n")}` : ""}`}</title>
                    </circle>
                    <text
                      x={fp.x + (fAnchor === "start" ? 7 : fAnchor === "end" ? -7 : 0)}
                      y={fp.y + (fAnchor === "middle" ? (Math.sin(fa) > 0 ? 14 : -8) : 3.5)}
                      className="web-label file"
                      textAnchor={fAnchor}
                    >
                      {fileLabel(f.path)}
                    </text>
                  </g>
                );
              })}
            {isOpen && dir.files.length > 14 && (
              <text x={p.x} y={p.y + size + 14} className="web-label faint" textAnchor="middle">
                +{dir.files.length - 14} more
              </text>
            )}
            <circle
              cx={p.x}
              cy={p.y}
              r={size}
              className={`web-dir ${isOpen ? "open" : ""}`}
              onClick={() => dir.files.length > 0 && toggle(key)}
            >
              <title>{`${dir.name} — ${dir.files.length} files, ${dir.tests} tests (click to ${isOpen ? "collapse" : "expand"})`}</title>
            </circle>
            <text x={lp.x} y={lp.y + labelDy} className="web-label" textAnchor={anchor}>
              {dir.name} <tspan className="faint">({dir.tests})</tspan>
            </text>
          </g>
        );
      })}
      <circle cx={cx} cy={cy} r={26 * scale} className="web-center" />
      <text x={cx} y={cy - 1} className="web-center-label" textAnchor="middle">
        {tree.label}
      </text>
      <text x={cx} y={cy + 13} className="web-label faint" textAnchor="middle">
        {tree.files.length} files · {total} tests
      </text>
    </g>
  );
}

interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MIN_W = W / 10;
const MAX_W = W * 4;

export default function SpiderWeb({ repos, global = false }: { repos: string[]; global?: boolean }) {
  const [data, setData] = useState<TreeResponse | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [view, setView] = useState<ViewBox>({ x: 0, y: 0, w: W, h: H });
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ px: number; py: number; view: ViewBox; moved: boolean } | null>(null);

  useEffect(() => {
    api("/api/tree").then((r) => r.json()).then(setData);
  }, []);

  const zoomAt = (factor: number, clientX?: number, clientY?: number) => {
    setView((v) => {
      const svg = svgRef.current;
      const rect = svg?.getBoundingClientRect();
      // Zoom toward the cursor when given, else toward the current center.
      const fx = rect && clientX != null ? (clientX - rect.left) / rect.width : 0.5;
      const fy = rect && clientY != null ? (clientY - rect.top) / rect.height : 0.5;
      const px = v.x + fx * v.w;
      const py = v.y + fy * v.h;
      const w = Math.min(MAX_W, Math.max(MIN_W, v.w * factor));
      const h = (w / W) * H;
      return { x: px - fx * w, y: py - fy * h, w, h };
    });
  };

  // Native wheel listener: React's onWheel is passive, so preventDefault
  // (needed to stop the page scrolling) only works here.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // Proportional to scroll delta: gentle on trackpads, ~1.08/notch on wheels.
      const factor = Math.exp(Math.max(-80, Math.min(80, e.deltaY)) * 0.001);
      zoomAt(factor, e.clientX, e.clientY);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [data]);

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    drag.current = { px: e.clientX, py: e.clientY, view, moved: false };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!d || !rect) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
    if (d.moved) {
      setView({
        ...d.view,
        x: d.view.x - (dx / rect.width) * d.view.w,
        y: d.view.y - (dy / rect.height) * d.view.h,
      });
    }
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  if (!data) return <div className="tree"><p className="meta-line">Weaving the web…</p></div>;

  const trees = repos.map((k) => data.trees.find((t) => t.key === k)).filter(Boolean) as RepoTree[];
  const dirPos = new Map<string, Positioned>();
  const single = trees.length === 1;
  const scale = single ? 1.1 : 0.78;

  // Endpoint bridges for the global view: dir of each referencing file.
  const fileDir = (p: string) => {
    const s = p.split("/");
    return s.slice(0, Math.min(2, s.length - 1)).join("/") || "(root)";
  };
  const bridges = global ? data.shared.slice(0, 14) : [];

  return (
    <div className="web-wrap">
      <div className="web-controls">
        <button onClick={() => zoomAt(1 / 1.3)}>+</button>
        <button onClick={() => zoomAt(1.3)}>−</button>
        <button onClick={() => setView({ x: 0, y: 0, w: W, h: H })}>reset</button>
      </div>
      <svg
        ref={svgRef}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        className={`web-svg ${drag.current?.moved ? "panning" : ""}`}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        {trees.map((tree, i) => (
          <RepoWeb
            key={tree.key}
            tree={tree}
            cx={single ? W / 2 : i === 0 ? W * 0.27 : W * 0.73}
            cy={H / 2}
            scale={scale}
            expanded={expanded}
            toggle={toggle}
            dirPos={dirPos}
          />
        ))}
        {bridges.map((b, i) => {
          const y = H / 2 - ((bridges.length - 1) * 40) / 2 + i * 40;
          const x = W / 2;
          return (
            <g key={b.endpoint}>
              {Object.entries(b.repos).flatMap(([repoKey, files]) =>
                [...new Set(files.map(fileDir))].map((dir) => {
                  const p = dirPos.get(`${repoKey}:${dir}`);
                  if (!p) return null;
                  return (
                    <path
                      key={`${repoKey}:${dir}`}
                      d={`M ${x} ${y} Q ${(x + p.x) / 2} ${(y + p.y) / 2 - 40} ${p.x} ${p.y}`}
                      className="web-bridge"
                    />
                  );
                }),
              )}
              <rect x={x - 90} y={y - 11} width={180} height={22} rx={11} className="web-endpoint" />
              <text x={x} y={y + 4} textAnchor="middle" className="web-label endpoint">
                {b.endpoint.length > 30 ? b.endpoint.slice(0, 29) + "…" : b.endpoint}
              </text>
            </g>
          );
        })}
        {global && bridges.length === 0 && (
          <text x={W / 2} y={H / 2} textAnchor="middle" className="web-label faint">
            no shared endpoints detected yet — the suites reference APIs in ways the scanner doesn't match
          </text>
        )}
      </svg>
      <p className="web-hint">scroll to zoom · drag to pan · click a directory node to fan out its files · hover for details</p>
    </div>
  );
}
