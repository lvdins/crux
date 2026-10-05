import { useCallback, useEffect, useRef, useState } from "react";
import type { AppConfig, ChatItem } from "./types";
import { api, WS_URL } from "./net";
import Chat from "./components/Chat";
import Preview from "./components/Preview";
import TestTree from "./components/TestTree";
import SpiderWeb from "./components/SpiderWeb";

type View = string | "connections"; // repo key, or the global graph

const VIEW_ICONS: Record<string, string> = { mkdocs: "📄", playwright: "🧪", pytest: "🔌" };

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [view, setView] = useState<View>("");
  const [testTab, setTestTab] = useState<"tree" | "web">("tree");
  const [items, setItems] = useState<ChatItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

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
        setBusy(false);
        if (!closed) retry = setTimeout(connect, 2000);
      };
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        setItems((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          switch (msg.type) {
            case "delta": {
              if (last?.kind === "agent" && last.streaming) {
                next[next.length - 1] = { ...last, text: last.text + msg.text };
              } else {
                next.push({ kind: "agent", text: msg.text, streaming: true });
              }
              return next;
            }
            case "block_end": {
              if (last?.kind === "agent" && last.streaming) {
                next[next.length - 1] = { ...last, streaming: false };
              }
              return next;
            }
            case "tool":
              next.push({ kind: "tool", name: msg.name });
              return next;
            case "error":
              next.push({ kind: "error", text: msg.message });
              return next;
            case "done": {
              setBusy(false);
              if (msg.costUsd != null) {
                const secs = msg.durationMs ? ` · ${(msg.durationMs / 1000).toFixed(1)}s` : "";
                next.push({ kind: "meta", text: `turn done · $${msg.costUsd.toFixed(4)}${secs}` });
              }
              return next;
            }
            default:
              return prev;
          }
        });
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      wsRef.current?.close();
    };
  }, []);

  const sendChat = useCallback((text: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    setItems((prev) => [...prev, { kind: "user", text }]);
    setBusy(true);
    ws.send(JSON.stringify({ type: "chat", text }));
  }, []);

  const selectView = useCallback(
    (next: View) => {
      setView(next);
      setTestTab("tree");
      if (config && next !== "connections" && config.repos[next]) {
        wsRef.current?.send(JSON.stringify({ type: "setRepo", repo: next }));
        setItems((prev) => [
          ...prev,
          { kind: "meta", text: `workspace → ${config.repos[next].label} (new conversation)` },
        ]);
      }
    },
    [config],
  );

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
        <span className="model-pill">claude · agent sdk</span>
        <span className="model-pill disabled" title="Codex adapter planned">codex · soon</span>
        <span className={`conn ${connected ? "on" : "off"}`}>{connected ? "connected" : "offline"}</span>
      </header>
      <div className="body">
        <nav className="sidebar">
          {Object.entries(config.repos).map(([key, r]) => (
            <button
              key={key}
              className={`side-item ${view === key ? "active" : ""}`}
              onClick={() => selectView(key)}
              title={r.path}
            >
              <span className="side-icon">{VIEW_ICONS[r.kind] ?? "📁"}</span>
              <span className="side-label">{r.label}</span>
            </button>
          ))}
          <div className="side-sep" />
          <button
            className={`side-item ${view === "connections" ? "active" : ""}`}
            onClick={() => selectView("connections")}
          >
            <span className="side-icon">🕸</span>
            <span className="side-label">Connections</span>
          </button>
        </nav>
        {view === "connections" ? (
          <section className="full-pane">
            <SpiderWeb repos={Object.entries(config.repos)
              .filter(([, r]) => r.kind !== "mkdocs")
              .map(([k]) => k)} global />
          </section>
        ) : (
          <div className="panes">
            <Chat items={items} busy={busy} onSend={sendChat} />
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
