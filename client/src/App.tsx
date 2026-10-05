import { useCallback, useEffect, useRef, useState } from "react";
import type { AppConfig, ChatItem } from "./types";
import { api, WS_URL } from "./net";
import Chat from "./components/Chat";
import Preview from "./components/Preview";
import TestTree from "./components/TestTree";

type Tab = "preview" | "tree";

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [repo, setRepo] = useState<string>("");
  const [tab, setTab] = useState<Tab>("preview");
  const [items, setItems] = useState<ChatItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    api("/api/config")
      .then((r) => r.json())
      .then((c: AppConfig) => {
        setConfig(c);
        setRepo(Object.keys(c.repos)[0]);
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

  const sendChat = useCallback(
    (text: string) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      setItems((prev) => [...prev, { kind: "user", text }]);
      setBusy(true);
      ws.send(JSON.stringify({ type: "chat", text }));
    },
    [],
  );

  const changeRepo = useCallback((key: string) => {
    setRepo(key);
    wsRef.current?.send(JSON.stringify({ type: "setRepo", repo: key }));
    setItems((prev) => [...prev, { kind: "meta", text: `switched workspace → new conversation` }]);
  }, []);

  if (!config) return <div className="loading">Loading SuperQA…</div>;

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">
          <span className="brand-dot" /> SuperQA
        </span>
        <select className="repo-select" value={repo} onChange={(e) => changeRepo(e.target.value)}>
          {Object.entries(config.repos).map(([key, r]) => (
            <option key={key} value={key}>
              {r.label} · {r.kind}
            </option>
          ))}
        </select>
        <span className="model-pill">claude · agent sdk</span>
        <span className="model-pill disabled" title="Codex adapter planned">codex · soon</span>
        <span className={`conn ${connected ? "on" : "off"}`}>{connected ? "connected" : "offline"}</span>
      </header>
      <div className="panes">
        <Chat items={items} busy={busy} onSend={sendChat} />
        <section className="right">
          <nav className="tabs">
            <button className={tab === "preview" ? "active" : ""} onClick={() => setTab("preview")}>
              Doc preview
            </button>
            <button className={tab === "tree" ? "active" : ""} onClick={() => setTab("tree")}>
              Test tree
            </button>
          </nav>
          {tab === "preview" ? <Preview port={config.preview.port} /> : <TestTree />}
        </section>
      </div>
    </div>
  );
}
