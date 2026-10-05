import { useEffect, useMemo, useState } from "react";
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
  const R1 = 190 * scale;
  const R2 = 320 * scale;
  const total = tree.files.reduce((n, f) => n + f.tests.length, 0);

  return (
    <g>
      {/* web rings */}
      {[0.55, 1, 1.45].map((m) => (
        <circle key={m} cx={cx} cy={cy} r={R1 * m} className="web-ring" />
      ))}
      {dirs.map((dir, i) => {
        const angle = (i / dirs.length) * Math.PI * 2 - Math.PI / 2;
        const p = polar(cx, cy, R1, angle);
        const key = `${tree.key}:${dir.name}`;
        dirPos.set(key, p);
        const isOpen = expanded.has(key);
        const size = Math.max(7, Math.min(17, 4 + Math.sqrt(dir.tests) * 1.6)) * scale;
        const shown = dir.files.slice(0, 14);
        return (
          <g key={dir.name}>
            <line x1={cx} y1={cy} x2={p.x} y2={p.y} className="web-edge" />
            {isOpen &&
              shown.map((f, j) => {
                const spread = Math.PI / 5;
                const fa = angle - spread / 2 + (spread * j) / Math.max(1, shown.length - 1);
                const fp = polar(cx, cy, R2, fa);
                return (
                  <g key={f.path}>
                    <line x1={p.x} y1={p.y} x2={fp.x} y2={fp.y} className="web-edge faint" />
                    <circle cx={fp.x} cy={fp.y} r={3.5 * scale + Math.min(4, f.tests / 4)} className="web-file">
                      <title>{`${f.path} — ${f.tests} tests${f.endpoints.length ? `\n${f.endpoints.join("\n")}` : ""}`}</title>
                    </circle>
                    <text x={fp.x} y={fp.y - 9 * scale} className="web-label file" textAnchor="middle">
                      {fileLabel(f.path)}
                    </text>
                  </g>
                );
              })}
            {isOpen && dir.files.length > 14 && (
              <text x={p.x} y={p.y + 24 * scale} className="web-label faint" textAnchor="middle">
                +{dir.files.length - 14} more files
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
            <text x={p.x} y={p.y - size - 5} className="web-label" textAnchor="middle">
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

export default function SpiderWeb({ repos, global = false }: { repos: string[]; global?: boolean }) {
  const [data, setData] = useState<TreeResponse | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    api("/api/tree").then((r) => r.json()).then(setData);
  }, []);

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
      <svg viewBox={`0 0 ${W} ${H}`} className="web-svg" preserveAspectRatio="xMidYMid meet">
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
      <p className="web-hint">click a directory node to fan out its files · hover for details</p>
    </div>
  );
}
