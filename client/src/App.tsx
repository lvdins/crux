import { useCallback, useEffect, useRef, useState } from "react";
import type { AppConfig } from "./types";
import { api, WS_URL } from "./net";
import Term, { disposeTerm } from "./components/Term";
import Preview from "./components/Preview";
import TestTree from "./components/TestTree";
import SpiderWeb from "./components/SpiderWeb";
import Connections from "./components/Connections";
import { WebIcon, ClaudeLogo, CodexLogo } from "./components/icons";

const CHIP_COLORS: Record<string, string> = {
  mkdocs: "#d9a05b",
  playwright: "#7ec98f",
  pytest: "#6fa8dc",
};

type View = string | "connections";

interface TermTab {
  id: string;
  title: string;
  agent?: string; // set when a launcher button started claude/codex here
  bootCmd?: string;
}

let tabSeq = 1;
const newTabId = (repo: string) => `${repo}:${tabSeq++}:${Date.now() % 100000}`;

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [view, setView] = useState<View>("");
  const [testTab, setTestTab] = useState<"tree" | "web">("tree");
  const [connected, setConnected] = useState(false);
  const [split, setSplit] = useState<number>(() => {
    const saved = Number(localStorage.getItem("qualitylab.split"));
    return saved >= 20 && saved <= 75 ? saved : 42;
  });
  const [dragging, setDragging] = useState(false);
  const [tabs, setTabs] = useState<Record<string, TermTab[]>>({});
  const [activeTab, setActiveTab] = useState<Record<string, string>>({});
  const [splits, setSplits] = useState<Record<string, string[]>>({});
  const [rightHidden, setRightHidden] = useState(() => localStorage.getItem("qualitylab.rightHidden") === "1");
  const [agentDrag, setAgentDrag] = useState<null | { cmd: "claude" | "codex"; x: number; y: number; zone: "tab" | "split" | null }>(null);
  const panesRef = useRef<HTMLDivElement>(null);
  const termPaneRef = useRef<HTMLElement>(null);
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
        localStorage.setItem("qualitylab.split", String(Math.round(v * 10) / 10));
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
        const initialTabs: Record<string, TermTab[]> = {};
        const initialActive: Record<string, string> = {};
        for (const key of Object.keys(c.repos)) {
          const id = newTabId(key);
          initialTabs[key] = [{ id, title: "shell" }];
          initialActive[key] = id;
        }
        setTabs(initialTabs);
        setActiveTab(initialActive);
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
          termHandlers.current.get(msg.id)?.(msg.data);
        } else if (msg.type === "term:exit") {
          termHandlers.current.get(msg.id)?.(`\r\n[shell exited: ${msg.code}]\r\n`);
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

  const subscribe = useCallback((id: string, handler: (data: string) => void) => {
    termHandlers.current.set(id, handler);
    return () => {
      if (termHandlers.current.get(id) === handler) termHandlers.current.delete(id);
    };
  }, []);

  const createTab = useCallback((repo: string, title = "shell", agent?: string, bootCmd?: string) => {
    const id = newTabId(repo);
    setTabs((prev) => ({ ...prev, [repo]: [...(prev[repo] ?? []), { id, title, agent, bootCmd }] }));
    return id;
  }, []);

  const addTab = useCallback(
    (repo: string, title = "shell", agent?: string, bootCmd?: string) => {
      const id = createTab(repo, title, agent, bootCmd);
      setActiveTab((prev) => ({ ...prev, [repo]: id }));
      return id;
    },
    [createTab],
  );

  const closeTab = useCallback(
    (repo: string, id: string) => {
      send({ type: "term:kill", id });
      disposeTerm(id);
      setSplits((prev) => ({ ...prev, [repo]: (prev[repo] ?? []).filter((s) => s !== id) }));
      setTabs((prev) => {
        const remaining = (prev[repo] ?? []).filter((t) => t.id !== id);
        const next = { ...prev, [repo]: remaining };
        setActiveTab((act) => {
          if (act[repo] !== id) return act;
          const fallback = remaining[remaining.length - 1]?.id;
          return { ...act, [repo]: fallback ?? "" };
        });
        if (remaining.length === 0) {
          // Never leave a workspace without a terminal.
          const freshId = newTabId(repo);
          next[repo] = [{ id: freshId, title: "shell" }];
          setActiveTab((act) => ({ ...act, [repo]: freshId }));
        }
        return next;
      });
    },
    [send],
  );

  const launchAgent = useCallback(
    (cmd: "claude" | "codex") => {
      if (view === "connections") return;
      const repoTabs = tabs[view] ?? [];
      const active = repoTabs.find((t) => t.id === activeTab[view]);
      if (active && !active.agent) {
        // Free shell tab: respawn it with the command baked into the shell
        // invocation (typing into a live shell races prompt init — p10k eats
        // typed-ahead input, so we never type commands at all).
        send({ type: "term:kill", id: active.id });
        disposeTerm(active.id);
        const id = newTabId(view);
        setTabs((prev) => ({
          ...prev,
          [view]: (prev[view] ?? []).map((t) =>
            t.id === active.id ? { id, title: cmd, agent: cmd, bootCmd: cmd } : t,
          ),
        }));
        setActiveTab((prev) => ({ ...prev, [view]: id }));
      } else {
        // Active tab already hosts an agent: open the new one in its own tab.
        addTab(view, cmd, cmd, cmd);
      }
    },
    [view, tabs, activeTab, send, addTab],
  );

  const zoneAt = useCallback((clientX: number, clientY: number): "tab" | "split" | null => {
    const rect = termPaneRef.current?.getBoundingClientRect();
    if (!rect) return null;
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;
    return clientX > rect.right - rect.width * 0.32 ? "split" : "tab";
  }, []);

  const startAgentDrag = useCallback(
    (cmd: "claude" | "codex") => (e: React.PointerEvent) => {
      if (view === "connections") return;
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      let started = false;
      const move = (ev: PointerEvent) => {
        if (!started && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 6) started = true;
        if (started) setAgentDrag({ cmd, x: ev.clientX, y: ev.clientY, zone: zoneAt(ev.clientX, ev.clientY) });
      };
      const up = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        setAgentDrag(null);
        if (!started) {
          launchAgent(cmd); // plain click
          return;
        }
        const zone = zoneAt(ev.clientX, ev.clientY);
        const splitAllowed = (splits[view] ?? []).length < 2; // 3 slots max
        if (zone === "tab" || (zone === "split" && !splitAllowed)) {
          addTab(view, cmd, cmd, cmd);
        } else if (zone === "split") {
          const id = createTab(view, cmd, cmd, cmd);
          setSplits((prev) => ({ ...prev, [view]: [...(prev[view] ?? []), id] }));
        }
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [view, zoneAt, launchAgent, addTab, createTab, splits],
  );

  const hideRight = (hidden: boolean) => {
    setRightHidden(hidden);
    localStorage.setItem("qualitylab.rightHidden", hidden ? "1" : "0");
  };

  if (!config) return <div className="loading">Loading QualityLab…</div>;

  const repo = view !== "connections" ? config.repos[view] : undefined;
  const isTestRepo = repo && repo.kind !== "mkdocs";
  const viewSplits = view !== "connections" ? splits[view] ?? [] : [];
  const splitInfos = viewSplits
    .map((id) => (tabs[view] ?? []).find((t) => t.id === id))
    .filter(Boolean) as TermTab[];
  const canSplit = viewSplits.length < 2;

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">
          <img src="/giraffe.png" alt="QualityLab" className="brand-logo" />
        </span>
        <span className="workspace-label">{repo ? repo.label : "Connections"}</span>
        <div className="agent-buttons">
          <button
            className="agent-btn"
            disabled={!repo}
            title={repo ? `Click to run claude · drag into the terminal for a tab or split` : "Pick a workspace first"}
            onPointerDown={repo ? startAgentDrag("claude") : undefined}
          >
            <ClaudeLogo /> Claude
          </button>
          <button
            className="agent-btn"
            disabled={!repo}
            title={repo ? `Click to run codex · drag into the terminal for a tab or split` : "Pick a workspace first"}
            onPointerDown={repo ? startAgentDrag("codex") : undefined}
          >
            <CodexLogo /> Codex
          </button>
        </div>
        <span className={`conn ${connected ? "on" : "off"}`}>{connected ? "connected" : "offline"}</span>
      </header>
      <div className="body">
        <nav className="sidebar">
          <div className="side-section">Workspaces</div>
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
              <span className="avatar" style={{ color: CHIP_COLORS[r.kind] ?? "var(--ink-soft)" }}>
                {key[0].toUpperCase()}
              </span>
              <span className="side-label">{r.label}</span>
            </button>
          ))}
          <div className="side-section">Views</div>
          <button
            className={`side-item ${view === "connections" ? "active" : ""}`}
            onClick={() => setView("connections")}
          >
            <span className="side-icon"><WebIcon /></span>
            <span className="side-label">Connections</span>
          </button>
          <div className="side-footer">
            <span className="avatar">D</span> dins · QualityLab 0.1
          </div>
        </nav>
        {view === "connections" ? (
          <section className="full-pane">
            <Connections />
          </section>
        ) : (
          <div
            className={`panes ${dragging ? "dragging" : ""}`}
            ref={panesRef}
            style={{ gridTemplateColumns: rightHidden ? "1fr 0px 0fr" : `${split}fr 6px ${100 - split}fr` }}
          >
            <section className="term-pane" ref={termPaneRef}>
              <div className="term-tabs">
                {(tabs[view] ?? [])
                  .filter((t) => !viewSplits.includes(t.id))
                  .map((t) => (
                    <span
                      key={t.id}
                      className={`term-tab ${activeTab[view] === t.id ? "active" : ""}`}
                      onClick={() => setActiveTab((prev) => ({ ...prev, [view]: t.id }))}
                    >
                      {t.agent === "claude" && <ClaudeLogo />}
                      {t.agent === "codex" && <CodexLogo />}
                      {t.title}
                      {(tabs[view] ?? []).length > 1 && (
                        <button
                          className="term-tab-close"
                          title="Close terminal"
                          onClick={(e) => {
                            e.stopPropagation();
                            closeTab(view, t.id);
                          }}
                        >
                          ×
                        </button>
                      )}
                    </span>
                  ))}
                <button className="term-tab-add" title="New terminal" onClick={() => addTab(view)}>
                  +
                </button>
              </div>
              <div className="term-slots">
                {(tabs[view] ?? [])
                  .filter((t) => t.id === activeTab[view] && !viewSplits.includes(t.id))
                  .map((t) => (
                    <div className="term-slot" key={t.id}>
                      <Term id={t.id} repo={view} bootCmd={t.bootCmd} connected={connected} send={send} subscribe={subscribe} />
                    </div>
                  ))}
                {splitInfos.map((t) => (
                  <div className="term-slot-group" key={t.id}>
                    <div className="term-split-divider" />
                    <div className="term-slot split">
                      <div className="term-slot-head">
                        {t.agent === "claude" && <ClaudeLogo />}
                        {t.agent === "codex" && <CodexLogo />}
                        {t.title}
                        <button
                          className="term-tab-close"
                          title="Close this terminal"
                          onClick={() => closeTab(view, t.id)}
                        >
                          ×
                        </button>
                      </div>
                      <Term id={t.id} repo={view} bootCmd={t.bootCmd} connected={connected} send={send} subscribe={subscribe} />
                    </div>
                  </div>
                ))}
              </div>
              {agentDrag && (
                <div className="drop-zones">
                  <div className={`drop-zone tab ${agentDrag.zone === "tab" || (agentDrag.zone === "split" && !canSplit) ? "over" : ""}`}>
                    <span>Open as new tab</span>
                  </div>
                  {canSplit && (
                    <div className={`drop-zone split ${agentDrag.zone === "split" ? "over" : ""}`}>
                      <span>Split right</span>
                    </div>
                  )}
                </div>
              )}
            </section>
            <div
              className={`splitter ${rightHidden ? "collapsed" : ""}`}
              onPointerDown={rightHidden ? undefined : onSplitDown}
              title="Drag to resize"
            />
            {
              <section className={`right ${rightHidden ? "collapsed" : ""}`}>
                {repo?.kind === "mkdocs" && (
                  <>
                    <nav className="tabs">
                      <button className="active">Doc preview</button>
                      <button className="pane-collapse" title="Hide panel" onClick={() => hideRight(true)}>»</button>
                    </nav>
                    <Preview port={config.preview.port} />
                  </>
                )}
                {isTestRepo && (
                  <>
                    <nav className="tabs">
                      <button className={testTab === "tree" ? "active" : ""} onClick={() => setTestTab("tree")}>
                        Tests
                      </button>
                      <button className={testTab === "web" ? "active" : ""} onClick={() => setTestTab("web")}>
                        Web
                      </button>
                      <button className="pane-collapse" title="Hide panel" onClick={() => hideRight(true)}>»</button>
                    </nav>
                    {testTab === "tree" ? <TestTree repo={view} /> : <SpiderWeb repos={[view]} />}
                  </>
                )}
              </section>
            }
            {rightHidden && (
              <button className="pane-reopen" title="Show panel" onClick={() => hideRight(false)}>
                «
              </button>
            )}
          </div>
        )}
      </div>
      {agentDrag && (
        <div className="drag-ghost" style={{ left: agentDrag.x, top: agentDrag.y }}>
          {agentDrag.cmd === "claude" ? <ClaudeLogo /> : <CodexLogo />} {agentDrag.cmd}
        </div>
      )}
    </div>
  );
}
