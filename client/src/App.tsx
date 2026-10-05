import { useCallback, useEffect, useRef, useState } from "react";
import type { AppConfig } from "./types";
import { api, WS_URL } from "./net";
import Term from "./components/Term";
import Preview from "./components/Preview";
import TestTree from "./components/TestTree";
import SpiderWeb from "./components/SpiderWeb";
import { iconFor, WebIcon } from "./components/icons";

type View = string | "connections";

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [view, setView] = useState<View>("");
  const [testTab, setTestTab] = useState<"tree" | "web">("tree");
  const [connected, setConnected] = useState(false);
  const [split, setSplit] = useState<number>(() => {
    const saved = Number(localStorage.getItem("superqa.split"));
    return saved >= 20 && saved <= 75 ? saved : 42;
  });
  const [dragging, setDragging] = useState(false);
  const panesRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termHandlers = useRef(new Map<string, (data: string) => void>());

  const onSplitDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    setDragging(true);
    const move = (ev: PointerEvent) => {
      const rect = panesRef.current?.getBoundingClientRect();
      if (!rect) return;
      const pct = Math.min(75, Math.max(20, ((ev.clientX - rect.left) / rect.width) * 100));
      setSplit(pct);
    };
    const up = () => {
      setDragging(false);
      setSplit((v) => {
        localStorage.setItem("superqa.split", String(Math.round(v * 10) / 10));
        return v;
      });
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, []);

  useEffect(() => {
    api("/api/config")
      .then((r) => r.json())
      .then((c: AppConfig) => {
        setConfig(c);
        setView(Object.keys(c.repos)[0]);
      });
  }, []);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 2000);
      };
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "term:data") {
          termHandlers.current.get(msg.repo)?.(msg.data);
        } else if (msg.type === "term:exit") {
          termHandlers.current.get(msg.repo)?.(`\r\n[shell exited: ${msg.code}]\r\n`);
        }
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      wsRef.current?.close();
    };
  }, []);

  const send = useCallback((payload: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }, []);

  const subscribe = useCallback((repo: string, handler: (data: string) => void) => {
    termHandlers.current.set(repo, handler);
    return () => {
      if (termHandlers.current.get(repo) === handler) termHandlers.current.delete(repo);
    };
  }, []);

  if (!config) return <div className="loading">Loading SuperQA…</div>;

  const repo = view !== "connections" ? config.repos[view] : undefined;
  const isTestRepo = repo && repo.kind !== "mkdocs";

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">
          <span className="brand-dot" /> SuperQA
        </span>
        <span className="workspace-label">{repo ? repo.label : "Connections"}</span>
        <span className="topbar-hint">run <code>claude</code> or <code>codex</code> in the terminal</span>
        <span className={`conn ${connected ? "on" : "off"}`}>{connected ? "connected" : "offline"}</span>
      </header>
      <div className="body">
        <nav className="sidebar">
          {Object.entries(config.repos).map(([key, r]) => (
            <button
              key={key}
              className={`side-item ${view === key ? "active" : ""}`}
              onClick={() => {
                setView(key);
                setTestTab("tree");
              }}
              title={r.path}
            >
              <span className="side-icon">{iconFor(r.kind)}</span>
              <span className="side-label">{r.label}</span>
            </button>
          ))}
          <div className="side-sep" />
          <button
            className={`side-item ${view === "connections" ? "active" : ""}`}
            onClick={() => setView("connections")}
          >
            <span className="side-icon"><WebIcon /></span>
            <span className="side-label">Connections</span>
          </button>
        </nav>
        {view === "connections" ? (
          <section className="full-pane">
            <SpiderWeb
              repos={Object.entries(config.repos)
                .filter(([, r]) => r.kind !== "mkdocs")
                .map(([k]) => k)}
              global
            />
          </section>
        ) : (
          <div
            className={`panes ${dragging ? "dragging" : ""}`}
            ref={panesRef}
            style={{ gridTemplateColumns: `minmax(280px, ${split}%) 6px minmax(340px, 1fr)` }}
          >
            <section className="term-pane">
              <Term repo={view} connected={connected} send={send} subscribe={subscribe} />
            </section>
            <div className="splitter" onPointerDown={onSplitDown} title="Drag to resize" />
            <section className="right">
              {repo?.kind === "mkdocs" && <Preview port={config.preview.port} />}
              {isTestRepo && (
                <>
                  <nav className="tabs">
                    <button className={testTab === "tree" ? "active" : ""} onClick={() => setTestTab("tree")}>
                      Tests
                    </button>
                    <button className={testTab === "web" ? "active" : ""} onClick={() => setTestTab("web")}>
                      Web
                    </button>
                  </nav>
                  {testTab === "tree" ? <TestTree repo={view} /> : <SpiderWeb repos={[view]} />}
                </>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
