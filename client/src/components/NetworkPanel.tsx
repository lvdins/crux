import { useEffect, useMemo, useRef, useState } from "react";
import RECORDER from "../netRecorder.js?raw";

/**
 * Lightweight network checker docked under the in-app browser: the page's
 * fetch / XHR calls (recorded by netRecorder.js) with status, timing, size
 * and request / response bodies. Polls the active tab once a second.
 */

interface NetEntry {
  id: number;
  type: "fetch" | "xhr";
  method: string;
  url: string;
  start: number;
  status: number;
  ms: number | null;
  size: number | null;
  ctype: string;
  reqBody: string | null;
  resBody: string | null;
  error: string | null;
}

async function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(cmd, args);
}

const fmtSize = (n: number | null) => (n == null ? "" : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1048576).toFixed(1)} MB`);

const splitUrl = (u: string) => {
  try {
    const x = new URL(u);
    return { host: x.host, path: x.pathname + x.search };
  } catch {
    return { host: "", path: u };
  }
};

const pretty = (body: string | null) => {
  if (!body) return "";
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
};

const statusClass = (s: number) => (s === 0 ? "pending" : s < 0 || s >= 500 ? "err" : s >= 400 ? "warn" : "ok");

export default function NetworkPanel({ label, active }: { label: string; active: boolean }) {
  const [entries, setEntries] = useState<NetEntry[]>([]);
  const [pageUrl, setPageUrl] = useState("");
  const [filter, setFilter] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [detailTab, setDetailTab] = useState<"response" | "request">("response");
  const [problem, setProblem] = useState("");
  const state = useRef({ page: "", since: 0, byId: new Map<number, NetEntry>() });
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // A different tab starts a fresh log.
  useEffect(() => {
    state.current = { page: "", since: 0, byId: new Map() };
    setEntries([]);
    setSelected(null);
  }, [label]);

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const script = `if (!window.__qlNet) { ${RECORDER} }\nreturn window.__qlNet.take(${state.current.since});`;
        const raw = await invoke<string>("browser_js", { label, script, pageWorld: true });
        const data = JSON.parse(raw) as { page: string; url: string; version: number; entries: NetEntry[] };
        const s = state.current;
        if (data.page !== s.page) {
          // New document: Chrome-style, the log restarts on navigation.
          s.page = data.page;
          s.byId = new Map();
          setSelected(null);
        }
        for (const e of data.entries) s.byId.set(e.id, e);
        s.since = data.version;
        setPageUrl(data.url);
        setEntries([...s.byId.values()].sort((a, b) => a.id - b.id));
        setProblem("");
      } catch (err) {
        setProblem(String(err).includes("not open") ? "Open a page to start recording" : String(err));
      }
      if (!stopped) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [active, label]);

  // Keep following new calls unless the user scrolled up.
  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return entries.filter((e) => (!errorsOnly || e.status < 0 || e.status >= 400) && (!q || `${e.method} ${e.url} ${e.status}`.toLowerCase().includes(q)));
  }, [entries, filter, errorsOnly]);
  const failed = entries.filter((e) => e.status < 0 || e.status >= 400).length;
  const sel = entries.find((e) => e.id === selected) ?? null;

  const clear = () => {
    state.current.byId = new Map();
    setEntries([]);
    setSelected(null);
    void invoke("browser_js", { label, script: "if (window.__qlNet) window.__qlNet.clear(); return 'ok';", pageWorld: true }).catch(() => undefined);
  };

  return (
    <div className="net">
      <div className="net-bar">
        <span className="net-title">Network</span>
        <input placeholder="Filter URL, method, status…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className={errorsOnly ? "on" : ""} onClick={() => setErrorsOnly((v) => !v)} title="Only 4xx / 5xx / failed">
          Errors {failed > 0 && <b>{failed}</b>}
        </button>
        <button onClick={clear}>Clear</button>
        <span className="net-count">
          {shown.length}/{entries.length} calls
        </span>
      </div>
      {problem && <div className="net-problem">{problem}</div>}
      <div className={`net-body ${sel ? "with-detail" : ""}`}>
        <div
          className="net-list"
          ref={listRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          {shown.length === 0 && !problem && (
            <div className="net-empty">{entries.length ? "No calls match." : `Waiting for fetch / XHR calls on ${splitUrl(pageUrl).host || "this page"}…`}</div>
          )}
          {shown.map((e) => {
            const { host, path } = splitUrl(e.url);
            return (
              <div key={e.id} className={`net-row ${selected === e.id ? "on" : ""} ${statusClass(e.status)}`} onClick={() => setSelected(selected === e.id ? null : e.id)}>
                <span className="net-status">{e.status === 0 ? "…" : e.status < 0 ? "ERR" : e.status}</span>
                <span className="net-method">{e.method}</span>
                <span className="net-url" title={e.url}>
                  {path}
                  {host && <small> {host}</small>}
                </span>
                <span className="net-ms">{e.ms == null ? "" : `${e.ms} ms`}</span>
                <span className="net-size">{fmtSize(e.size)}</span>
              </div>
            );
          })}
        </div>
        {sel && (
          <div className="net-detail">
            <div className="net-detail-head">
              <span className={`net-status ${statusClass(sel.status)}`}>{sel.status < 0 ? "ERR" : sel.status || "…"}</span>
              <b>{sel.method}</b>
              <code title={sel.url}>{sel.url}</code>
              <button onClick={() => void navigator.clipboard.writeText(sel.url)} title="Copy URL">
                copy
              </button>
              <button onClick={() => setSelected(null)} title="Close">
                ×
              </button>
            </div>
            <div className="net-detail-tabs">
              <button className={detailTab === "response" ? "on" : ""} onClick={() => setDetailTab("response")}>
                Response
              </button>
              <button className={detailTab === "request" ? "on" : ""} onClick={() => setDetailTab("request")}>
                Request
              </button>
              <span>
                {sel.ms != null && `${sel.ms} ms`} {sel.size != null && `· ${fmtSize(sel.size)}`} {sel.ctype && `· ${sel.ctype.split(";")[0]}`}
              </span>
            </div>
            <pre className="net-pre">
              {sel.error
                ? sel.error
                : detailTab === "response"
                  ? pretty(sel.resBody) || (sel.status === 0 ? "Waiting for response…" : "(no text body)")
                  : pretty(sel.reqBody) || "(no body)"}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
