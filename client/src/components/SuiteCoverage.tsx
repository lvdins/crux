import { useEffect, useMemo, useState } from "react";
import { api } from "../net";
import type { Feature, FeatureMapData } from "./FeatureMap";

/**
 * Per-suite coverage for the right panel of a test workspace, cut from the
 * same feature map as Connections:
 *  - e2e: which features / dashboard pages the Playwright suite reaches
 *  - api: which endpoints / backend views the pytest suite hits
 */

type Suite = "e2e" | "api";

const pct = (a: number, b: number) => (b === 0 ? 0 : Math.round((a / b) * 100));

interface Row {
  f: Feature;
  covered: number;
  total: number;
  bar: number; // 0..100
  text: string;
  tone: "good" | "mid" | "bad";
}

function rowsFor(suite: Suite, features: Feature[]): Row[] {
  return features
    .map((f): Row => {
      if (suite === "api") {
        const total = f.coverage.endpoints;
        const covered = f.coverage.apiCovered;
        const bar = pct(covered, total);
        return { f, covered, total, bar, text: `${covered}/${total}`, tone: bar === 100 ? "good" : bar === 0 ? "bad" : "mid" };
      }
      // E2E specs mostly navigate by clicking, so "reached" (any linked spec)
      // is the headline; opened pages refine it when the feature has pages.
      const specs = f.e2e.length;
      const opened = f.pages.filter((p) => p.e2e.length > 0).length;
      const bar = specs === 0 ? 0 : f.pages.length ? Math.max(35, pct(opened, f.pages.length)) : 100;
      return {
        f,
        covered: specs > 0 ? 1 : 0,
        total: 1,
        bar,
        text: specs === 0 ? "no spec" : `${specs} spec${specs === 1 ? "" : "s"}`,
        tone: specs === 0 ? "bad" : f.pages.length && opened < f.pages.length ? "mid" : "good",
      };
    })
    .filter((r) => r.total > 0 && (suite === "e2e" ? r.f.coverage.endpoints > 0 || r.f.pages.length > 0 || r.f.e2e.length > 0 : true));
}

function E2eDetail({ f }: { f: Feature }) {
  return (
    <div className="sc-detail">
      {f.pages.length > 0 && (
        <>
          <div className="sc-sub">Pages</div>
          {f.pages.map((p) => (
            <div key={p.route} className={`sc-line ${p.e2e.length ? "ok" : "miss"}`}>
              <span className="sc-mark">{p.e2e.length ? "✓" : "✗"}</span>
              <code>{p.route}</code>
              <span className="sc-count">{p.e2e.length ? `${p.e2e.length} spec${p.e2e.length === 1 ? "" : "s"}` : "not opened"}</span>
            </div>
          ))}
        </>
      )}
      <div className="sc-sub">Linked specs</div>
      {f.e2e.length === 0 ? (
        <div className="sc-none">No Playwright spec reaches this feature.</div>
      ) : (
        f.e2e.map((t) => (
          <div key={t.file} className="sc-file">
            <code title={t.file}>{t.file.replace(/^tests\//, "")}</code>
            <span className="sc-count">{t.tests} tests</span>
            <div className="sc-via">
              {t.via.slice(0, 4).map((v) => (
                <span key={v}>{v}</span>
              ))}
              {t.via.length > 4 && <span>+{t.via.length - 4}</span>}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function ApiDetail({ f }: { f: Feature }) {
  const sorted = [...f.endpoints].sort((a, b) => Number(a.apiTests.length > 0) - Number(b.apiTests.length > 0));
  return (
    <div className="sc-detail">
      <div className="sc-sub">Endpoints</div>
      {sorted.map((e) => (
        <div key={e.path} className={`sc-line ${e.apiTests.length ? "ok" : "miss"}`} title={e.apiTests.join("\n")}>
          <span className="sc-mark">{e.apiTests.length ? "✓" : "✗"}</span>
          <code>
            {e.methods.length > 0 && <b>{e.methods.join(" ")} </b>}/{e.path.replace(/\{\}/g, "{id}")}
          </code>
          <span className="sc-count">{e.apiTests.length ? `${e.apiTests.length} test file${e.apiTests.length === 1 ? "" : "s"}` : e.backend?.view ?? "no backend route"}</span>
        </div>
      ))}
    </div>
  );
}

export default function SuiteCoverage({ suite, repoKey }: { suite: Suite; repoKey: string }) {
  const [data, setData] = useState<FeatureMapData | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [gapsOnly, setGapsOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api("/api/features")
      .then((r) => r.json())
      .then(setData)
      .catch((err) => setError(String(err)));
  }, []);

  const rows = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return rowsFor(suite, data.features)
      .filter((r) => !gapsOnly || r.covered < r.total)
      .filter((r) => !q || `${r.f.label} ${r.f.endpoints.map((e) => e.path).join(" ")} ${r.f.pages.map((p) => p.route).join(" ")}`.toLowerCase().includes(q))
      .sort((a, b) => a.bar - b.bar || b.f.coverage.endpoints - a.f.coverage.endpoints);
  }, [data, suite, gapsOnly, query]);

  if (error) return <div className="sc-empty">{error}</div>;
  if (!data) return <div className="sc-empty">Reading the dashboard and test suites…</div>;
  if (!data.ready) {
    return (
      <div className="sc-empty">
        Coverage needs the dashboard repo. Add it as a workspace (type <b>Frontend</b>) and open <b>Connections</b>.
      </div>
    );
  }

  const source = data.sources[suite];
  const elsewhere = source && source.key !== repoKey;
  const all = rowsFor(suite, data.features);
  const totalCovered = all.reduce((n, r) => n + r.covered, 0);
  const total = all.reduce((n, r) => n + r.total, 0);
  const pagesTotal = data.features.reduce((n, f) => n + f.pages.length, 0);
  const pagesOpened = data.features.reduce((n, f) => n + f.pages.filter((pg) => pg.e2e.length > 0).length, 0);
  const featuresReached = data.features.filter((f) => (suite === "api" ? f.coverage.apiCovered > 0 : f.e2e.length > 0)).length;
  const views = new Map<string, boolean>();
  if (suite === "api") {
    for (const f of data.features)
      for (const e of f.endpoints) if (e.backend) views.set(e.backend.view, (views.get(e.backend.view) ?? false) || e.apiTests.length > 0);
  }
  const viewsCovered = [...views.values()].filter(Boolean).length;
  const p = pct(totalCovered, total);

  const copyGaps = async () => {
    const lines =
      suite === "api"
        ? data.features.flatMap((f) => f.endpoints.filter((e) => !e.apiTests.length).map((e) => `${f.label}\t${e.methods.join(",") || "-"}\t/${e.path}\t${e.backend?.view ?? "no backend route"}`))
        : data.features.flatMap((f) => [
            ...f.pages.filter((pg) => !pg.e2e.length).map((pg) => `${f.label}\tpage\t${pg.route}`),
            ...(f.e2e.length === 0 && f.coverage.endpoints > 0 ? [`${f.label}\tfeature\tno spec`] : []),
          ]);
    await navigator.clipboard.writeText(lines.join("\n")).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="sc">
      <div className="sc-head">
        <div className="sc-ring" style={{ ["--p" as string]: p }}>
          <span>{p}%</span>
        </div>
        <div className="sc-summary">
          <div className="sc-title">{suite === "api" ? "Endpoint coverage" : "Feature coverage"}</div>
          <div className="sc-facts">
            {suite === "api" ? (
              <span>
                <b>{totalCovered}</b>/{total} endpoints hit
              </span>
            ) : (
              <span>
                <b>{totalCovered}</b>/{total} features reached
              </span>
            )}
            {suite === "api" ? (
              <span>
                <b>{featuresReached}</b>/{data.features.length} features touched
              </span>
            ) : (
              <span>
                <b>{pagesOpened}</b>/{pagesTotal} pages opened directly
              </span>
            )}
            {suite === "api" && (
              <span>
                <b>{viewsCovered}</b>/{views.size} backend views
              </span>
            )}
          </div>
        </div>
      </div>
      {elsewhere && (
        <div className="sc-note">
          Coverage is computed for <b>{source!.label}</b>, the first {suite === "api" ? "pytest" : "Playwright"} workspace.
        </div>
      )}
      <div className="sc-tools">
        <input placeholder="Filter features, routes, endpoints…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className={gapsOnly ? "on" : ""} onClick={() => setGapsOnly((g) => !g)}>
          Gaps only
        </button>
        <button onClick={copyGaps} title="Copy every gap as tab-separated lines">
          {copied ? "Copied" : "Copy gaps"}
        </button>
      </div>
      <div className="sc-list">
        {rows.map((r) => {
          const tone = r.tone;
          return (
            <div key={r.f.id} className={`sc-row ${open === r.f.id ? "open" : ""}`}>
              <button className="sc-row-head" onClick={() => setOpen(open === r.f.id ? null : r.f.id)}>
                <span className={`sc-twisty ${open === r.f.id ? "open" : ""}`}>›</span>
                <span className="sc-label">{r.f.label}</span>
                <span className={`sc-bar ${tone}`}>
                  <span style={{ width: `${r.bar}%` }} />
                </span>
                <span className={`sc-frac ${tone}`}>
                  {r.text}
                </span>
              </button>
              {open === r.f.id && (suite === "api" ? <ApiDetail f={r.f} /> : <E2eDetail f={r.f} />)}
            </div>
          );
        })}
        {rows.length === 0 && <div className="sc-empty">{gapsOnly ? "No gaps — everything here is covered." : "Nothing matches."}</div>}
      </div>
    </div>
  );
}
