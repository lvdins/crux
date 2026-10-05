import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../net";
import FeatureGraph from "./FeatureGraph";

export interface FeatureEndpoint {
  path: string;
  methods: string[];
  backend?: { view: string; file?: string; line?: number };
  apiTests: string[];
  e2eTests: string[];
}
export interface FeatureLink {
  file: string;
  tests: number;
  via: string[];
}
export interface Feature {
  id: string;
  label: string;
  group: string;
  module: string;
  files: number;
  pages: { route: string; e2e: string[] }[];
  endpoints: FeatureEndpoint[];
  e2e: FeatureLink[];
  api: FeatureLink[];
  coverage: { endpoints: number; apiCovered: number; backendResolved: number; e2eTests: number; apiTests: number };
}
export interface Source {
  key: string;
  label: string;
  path: string;
}
export interface FeatureMapData {
  ready: boolean;
  missing: string[];
  sources: Record<string, Source | null>;
  features: Feature[];
  totals: { features: number; endpoints: number; apiCovered: number; noE2e: number; noApi: number };
  builtAt: string;
  ms: number;
}

type Filter = "all" | "gaps" | "noE2e" | "noApi";
type Status = "good" | "partial" | "gap" | "empty";

const SOURCE_INFO: Record<string, { title: string; hint: string }> = {
  dashboard: { title: "Dashboard", hint: "The Next.js app — features, pages and the endpoints they call" },
  backend: { title: "Backend", hint: "The Django service — resolves each endpoint to its view" },
  e2e: { title: "E2E tests", hint: "Playwright suite — linked by pages, endpoints and page objects" },
  api: { title: "API tests", hint: "pytest suite — linked by the endpoints it hits" },
};

function statusOf(f: Feature): Status {
  const { endpoints, apiCovered } = f.coverage;
  if (endpoints === 0 && f.e2e.length === 0) return "empty";
  const apiOk = endpoints === 0 || apiCovered / endpoints >= 0.6;
  const e2eOk = f.e2e.length > 0;
  if (apiOk && e2eOk) return "good";
  if (apiOk || e2eOk || apiCovered > 0) return "partial";
  return "gap";
}

const STATUS_LABEL: Record<Status, string> = {
  good: "Covered",
  partial: "Partial",
  gap: "Gap",
  empty: "No signal",
};

const pct = (a: number, b: number) => (b === 0 ? 0 : Math.round((a / b) * 100));

function EndpointPath({ path }: { path: string }) {
  // Highlight path params so the shape reads at a glance.
  return (
    <span className="fm-path">
      /
      {path.split("/").map((seg, i, all) => (
        <span key={i}>
          {seg === "{}" ? <span className="fm-param">{"{id}"}</span> : seg}
          {i < all.length - 1 && "/"}
        </span>
      ))}
    </span>
  );
}

function Bar({ value, total, tone }: { value: number; total: number; tone: "api" | "e2e" }) {
  const p = total === 0 ? 0 : Math.min(100, (value / total) * 100);
  return (
    <span className={`fm-bar ${tone}`}>
      <span style={{ width: `${p}%` }} />
    </span>
  );
}

function FileList({ files, empty }: { files: FeatureLink[]; empty: string }) {
  const [open, setOpen] = useState<string | null>(null);
  if (files.length === 0) return <div className="fm-empty-row">{empty}</div>;
  return (
    <div className="fm-files">
      {files.map((f) => (
        <div key={f.file} className="fm-file">
          <button className="fm-file-head" onClick={() => setOpen(open === f.file ? null : f.file)}>
            <span className="fm-file-name" title={f.file}>
              <span className="fm-file-dir">{f.file.split("/").slice(0, -1).join("/")}/</span>
              {f.file.split("/").pop()}
            </span>
            <span className="fm-file-meta">
              {f.tests} test{f.tests === 1 ? "" : "s"} · {f.via.length} link{f.via.length === 1 ? "" : "s"}
            </span>
          </button>
          {open === f.file && (
            <div className="fm-via">
              {f.via.map((v) => (
                <span key={v} className="fm-chip">
                  {v}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function Detail({ f, sources }: { f: Feature; sources: Record<string, Source | null> }) {
  const [showApiFor, setShowApiFor] = useState<string | null>(null);
  const status = statusOf(f);
  const { endpoints, apiCovered, backendResolved, e2eTests, apiTests } = f.coverage;
  const uncovered = f.endpoints.filter((e) => e.apiTests.length === 0).length;

  return (
    <div className="fm-detail">
      <div className="fm-detail-head">
        <div>
          <div className="fm-detail-title">
            {f.label}
            <span className={`fm-status ${status}`}>{STATUS_LABEL[status]}</span>
          </div>
          <div className="fm-detail-sub" title={sources.dashboard?.path}>
            {f.module} · {f.files} files
          </div>
        </div>
      </div>

      <div className="fm-flow">
        <div className="fm-flow-step e2e">
          <span className="fm-flow-n">{f.e2e.length}</span>
          <span>E2E files</span>
          <small>{e2eTests} tests</small>
        </div>
        <span className="fm-flow-arrow">→</span>
        <div className="fm-flow-step">
          <span className="fm-flow-n">{f.pages.length}</span>
          <span>Pages</span>
          <small>{f.pages.filter((p) => p.e2e.length).length} visited by E2E</small>
        </div>
        <span className="fm-flow-arrow">→</span>
        <div className="fm-flow-step">
          <span className="fm-flow-n">{endpoints}</span>
          <span>Endpoints</span>
          <small>{backendResolved} mapped to backend</small>
        </div>
        <span className="fm-flow-arrow">←</span>
        <div className="fm-flow-step api">
          <span className="fm-flow-n">{f.api.length}</span>
          <span>API files</span>
          <small>
            {apiTests} tests · {pct(apiCovered, endpoints)}% of endpoints
          </small>
        </div>
      </div>

      <section className="fm-section">
        <h4>
          Endpoints
          {uncovered > 0 && <span className="fm-warn-pill">{uncovered} without API test</span>}
        </h4>
        {f.endpoints.length === 0 ? (
          <div className="fm-empty-row">No /gapi calls found in this module.</div>
        ) : (
          <div className="fm-table">
            {f.endpoints.map((e) => (
              <div key={e.path} className={`fm-row ${e.apiTests.length ? "" : "uncovered"}`}>
                <div className="fm-row-main">
                  <span className="fm-methods">
                    {(e.methods.length ? e.methods : ["·"]).map((m) => (
                      <span key={m} className={`fm-method ${m.toLowerCase()}`} title={m === "·" ? "HTTP method not detected" : undefined}>
                        {m === "·" ? "—" : m}
                      </span>
                    ))}
                  </span>
                  <EndpointPath path={e.path} />
                </div>
                <div className="fm-row-side">
                  {e.backend ? (
                    <span className="fm-backend" title={e.backend.file ? `${e.backend.file}:${e.backend.line ?? ""}` : undefined}>
                      {e.backend.view}
                      {e.backend.file && <small>{e.backend.file.split("/").pop()}</small>}
                    </span>
                  ) : (
                    <span className="fm-backend missing">No backend route</span>
                  )}
                  {e.e2eTests.length > 0 && <span className="fm-tag e2e">E2E</span>}
                  {e.apiTests.length > 0 ? (
                    <button className="fm-tag api" onClick={() => setShowApiFor(showApiFor === e.path ? null : e.path)}>
                      {e.apiTests.length} API
                    </button>
                  ) : (
                    <span className="fm-tag none">No API test</span>
                  )}
                </div>
                {showApiFor === e.path && (
                  <div className="fm-row-tests">
                    {e.apiTests.map((t) => (
                      <code key={t}>{t}</code>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="fm-two">
        <section className="fm-section">
          <h4>Pages</h4>
          {f.pages.length === 0 ? (
            <div className="fm-empty-row">Not the main module of any page.</div>
          ) : (
            <div className="fm-pages">
              {f.pages.map((p) => (
                <div key={p.route} className="fm-page">
                  <code>{p.route}</code>
                  {p.e2e.length > 0 ? (
                    <span className="fm-tag e2e" title={p.e2e.join("\n")}>
                      E2E ×{p.e2e.length}
                    </span>
                  ) : (
                    <span className="fm-tag faint">not opened by E2E</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
        <section className="fm-section">
          <h4>E2E tests</h4>
          <FileList files={f.e2e} empty="No Playwright test linked to this feature." />
        </section>
      </div>

      <section className="fm-section">
        <h4>API tests</h4>
        <FileList files={f.api} empty="No pytest file hits these endpoints." />
      </section>
    </div>
  );
}

export default function FeatureMap({ onAddWorkspace }: { onAddWorkspace: () => void }) {
  const [data, setData] = useState<FeatureMapData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(() => localStorage.getItem("qualitylab.feature"));
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [tab, setTab] = useState<"coverage" | "graph">(() =>
    localStorage.getItem("qualitylab.connTab") === "graph" ? "graph" : "coverage",
  );
  const switchTab = (next: "coverage" | "graph") => {
    setTab(next);
    localStorage.setItem("qualitylab.connTab", next);
  };

  const load = useCallback((refresh = false) => {
    setLoading(true);
    setError("");
    api(`/api/features${refresh ? "?refresh=1" : ""}`)
      .then((r) => r.json())
      .then((d: FeatureMapData) => setData(d))
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => load(), [load]);

  useEffect(() => {
    if (selected) localStorage.setItem("qualitylab.feature", selected);
  }, [selected]);

  const visible = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.features.filter((f) => {
      if (q && !`${f.label} ${f.id} ${f.endpoints.map((e) => e.path).join(" ")} ${f.pages.map((p) => p.route).join(" ")}`.toLowerCase().includes(q)) return false;
      const s = statusOf(f);
      if (filter === "gaps") return s === "gap" || s === "partial";
      if (filter === "noE2e") return f.e2e.length === 0 && s !== "empty";
      if (filter === "noApi") return f.coverage.endpoints > 0 && f.coverage.apiCovered < f.coverage.endpoints;
      return true;
    });
  }, [data, query, filter]);

  const current = data?.features.find((f) => f.id === selected) ?? visible[0];

  if (!data) {
    return <div className="fm-loading">{error || "Reading dashboard, backend and test suites…"}</div>;
  }

  if (!data.ready || data.missing.length > 0) {
    // Setup card: which repos the map needs, which are already there.
    const setup = (
      <div className="fm-setup">
        {Object.entries(SOURCE_INFO).map(([k, info]) => {
          const src = data.sources[k];
          return (
            <div key={k} className={`fm-setup-card ${src ? "ok" : ""}`}>
              <div className="fm-setup-title">
                <span className={`fm-dot ${src ? "good" : "gap"}`} />
                {info.title}
              </div>
              <div className="fm-setup-hint">{src ? src.path : info.hint}</div>
              {!src && (
                <button className="primary" onClick={onAddWorkspace}>
                  + Add folder
                </button>
              )}
            </div>
          );
        })}
      </div>
    );
    if (!data.ready) {
      return (
        <div className="fm-onboard">
          <h2>Connect your repos</h2>
          <p>The feature map reads the dashboard to find features, then links them to backend views, E2E tests and API tests.</p>
          {setup}
          <button onClick={() => load(true)}>Re-scan</button>
        </div>
      );
    }
  }

  const t = data.totals;
  const filters: [Filter, string, number][] = [
    ["all", "All", data.features.length],
    ["gaps", "Gaps", data.features.filter((f) => ["gap", "partial"].includes(statusOf(f))).length],
    ["noE2e", "No E2E", t.noE2e],
    ["noApi", "API gaps", data.features.filter((f) => f.coverage.endpoints > 0 && f.coverage.apiCovered < f.coverage.endpoints).length],
  ];
  let lastGroup = "";

  return (
    <div className="fm">
      <header className="fm-top">
        <div className="fm-tabs">
          <button className={tab === "coverage" ? "on" : ""} onClick={() => switchTab("coverage")}>
            Coverage
          </button>
          <button className={tab === "graph" ? "on" : ""} onClick={() => switchTab("graph")}>
            Graph
          </button>
        </div>
        <div className="fm-stats">
          <div className="fm-stat">
            <b>{t.features}</b>
            <span>features</span>
          </div>
          <div className="fm-stat">
            <b>{t.endpoints}</b>
            <span>endpoints</span>
          </div>
          <div className="fm-stat">
            <b>{pct(t.apiCovered, t.endpoints)}%</b>
            <span>API-covered</span>
          </div>
          <div className="fm-stat warn">
            <b>{t.noE2e}</b>
            <span>without E2E</span>
          </div>
        </div>
        <div className="fm-tools">
          {tab === "coverage" && (
            <>
          <input className="fm-search" placeholder="Search features, routes, endpoints…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="fm-seg">
            {filters.map(([key, label, n]) => (
              <button key={key} className={filter === key ? "on" : ""} onClick={() => setFilter(key)}>
                {label} <small>{n}</small>
              </button>
            ))}
          </div>
            </>
          )}
          <button className="fm-refresh" onClick={() => load(true)} disabled={loading} title={`Scanned in ${data.ms} ms`}>
            {loading ? "Scanning…" : "Re-scan"}
          </button>
        </div>
      </header>
      {data.missing.length > 0 && (
        <div className="fm-missing">
          Missing {data.missing.map((m) => SOURCE_INFO[m]?.title ?? m).join(", ")} — links from those repos are left out.
          <button onClick={onAddWorkspace}>Add folder</button>
        </div>
      )}
      {tab === "graph" ? (
        <div className="fm-graph">
          <FeatureGraph
            data={data}
            onOpenFeature={(id) => {
              setSelected(id);
              setFilter("all");
              setQuery("");
              switchTab("coverage");
            }}
          />
        </div>
      ) : (
      <div className="fm-body">
        <nav className="fm-list">
          {visible.length === 0 && <div className="fm-empty-row">Nothing matches.</div>}
          {visible.map((f) => {
            const header = f.group !== lastGroup ? f.group : null;
            lastGroup = f.group;
            const s = statusOf(f);
            return (
              <div key={f.id}>
                {header && <div className="fm-group">{header}</div>}
                <button className={`fm-item ${current?.id === f.id ? "active" : ""}`} onClick={() => setSelected(f.id)}>
                  <span className={`fm-dot ${s}`} title={STATUS_LABEL[s]} />
                  <span className="fm-item-main">
                    <span className="fm-item-label">{f.label}</span>
                    <span className="fm-item-bars">
                      <Bar value={f.coverage.apiCovered} total={f.coverage.endpoints} tone="api" />
                      <Bar value={f.e2e.length} total={Math.max(3, f.e2e.length)} tone="e2e" />
                    </span>
                  </span>
                  <span className="fm-item-meta">
                    {f.coverage.apiCovered}/{f.coverage.endpoints}
                    <small>{f.e2e.length} e2e</small>
                  </span>
                </button>
              </div>
            );
          })}
        </nav>
        <div className="fm-main">{current ? <Detail key={current.id} f={current} sources={data.sources} /> : null}</div>
      </div>
      )}
    </div>
  );
}
