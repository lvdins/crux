import { useCallback, useEffect, useRef, useState } from "react";
import type { AppConfig, RepoInfo } from "./types";
import { api, WS_URL } from "./net";
import Term, { disposeTerm } from "./components/Term";
import Preview from "./components/Preview";
import TestTree from "./components/TestTree";
import SuiteCoverage from "./components/SuiteCoverage";
import Browser from "./components/Browser";
import { runAgentCommand, browserLabel } from "./agentBrowser";
import FeatureMap from "./components/FeatureMap";
import AddWorkspace from "./components/AddWorkspace";
import SetupChecklist from "./components/SetupChecklist";
import JiraMenu, { loadJiraBoards, saveJiraBoards } from "./components/JiraMenu";
import ContextMenu, { MenuIcons } from "./components/ContextMenu";
import { WebIcon, ClaudeLogo, CodexLogo, JiraIcon } from "./components/icons";

const CHIP_COLORS: Record<string, string> = {
  mkdocs: "#d9a05b",
  playwright: "#7ec98f",
  pytest: "#6fa8dc",
  frontend: "#e8a0bf",
  backend: "#9fc5b0",
  generic: "#b4a7d6",
};

type View = string | "connections";

/** Workspace colours offered in the right-click menu. */
export const WORKSPACE_COLORS = ["#e5484d", "#f76b15", "#ffc53d", "#46a758", "#12a594", "#0090ff", "#5b5bd6", "#8e4ec6", "#d6409f"];

/** Coloured workspaces get a filled badge; others tint the letter by type. */
function avatarStyle(r: { kind: string; color?: string }): React.CSSProperties {
  if (!r.color) return { color: CHIP_COLORS[r.kind] ?? "var(--ink-soft)" };
  const light = ["#ffc53d"].includes(r.color.toLowerCase());
  return { background: r.color, borderColor: r.color, color: light ? "#1b1c20" : "#fff" };
}

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
  // Right-panel tab per workspace: tree / coverage / preview / browser.
  const [panelTabs, setPanelTabs] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem("qualitylab.panelTabs") ?? "{}");
    } catch {
      return {};
    }
  });
  const setPanelTab = (key: string, tab: string) =>
    setPanelTabs((prev) => {
      const next = { ...prev, [key]: tab };
      localStorage.setItem("qualitylab.panelTabs", JSON.stringify(next));
      return next;
    });
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
  const [sideHidden, setSideHidden] = useState(() => localStorage.getItem("qualitylab.sideHidden") === "1");
  const toggleSide = () =>
    setSideHidden((h) => {
      localStorage.setItem("qualitylab.sideHidden", h ? "0" : "1");
      return !h;
    });
  // Agent drove the browser of the workspace on screen: show it.
  const revealBrowserRef = useRef<(ws: string) => void>(() => {});
  const [viewsHidden, setViewsHidden] = useState(() => localStorage.getItem("qualitylab.viewsHidden") === "1");
  const toggleViews = () =>
    setViewsHidden((h) => {
      localStorage.setItem("qualitylab.viewsHidden", h ? "0" : "1");
      return !h;
    });
  const toggleSideRef = useRef(toggleSide);
  const toggleRightRef = useRef<() => void>(() => {});
  toggleSideRef.current = toggleSide;
  const [adding, setAdding] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [jiraMenu, setJiraMenu] = useState<DOMRect | null>(null);
  const [jiraBoards, setJiraBoards] = useState(loadJiraBoards);
  const [jiraOpen, setJiraOpen] = useState<{ url: string; nonce: number } | null>(null);
  const [menu, setMenu] = useState<null | { key: string; x: number; y: number }>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [toast, setToast] = useState("");
  const [unread, setUnread] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("qualitylab.unread") ?? "[]"));
    } catch {
      return new Set();
    }
  });
  const viewRef = useRef(view);
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
        const keys = Object.keys(c.repos);
        const last = localStorage.getItem("qualitylab.view");
        setView(last && (last === "connections" || last === "jira" || keys.includes(last)) ? last : keys[0] ?? "");
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
      ws.onopen = () => {
        setConnected(true);
        // The desktop window owns the native browser panes: offer to run
        // agent browser commands for the server.
        if ("__TAURI_INTERNALS__" in window) ws.send(JSON.stringify({ type: "browser:host" }));
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 2000);
      };
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "browser:cmd") {
          revealBrowserRef.current(msg.ws);
          runAgentCommand(msg.ws, msg.op, msg.args ?? {})
            .then((result) => ws.send(JSON.stringify({ type: "browser:result", id: msg.id, ok: true, result })))
            .catch((err) => ws.send(JSON.stringify({ type: "browser:result", id: msg.id, ok: false, error: String(err?.message ?? err) })));
          return;
        }
        if (msg.type === "term:data") {
          termHandlers.current.get(msg.id)?.(msg.data);
          // Output in a workspace you're not looking at (an agent finishing,
          // a test run) flags it unread in the sidebar.
          const wsKey = String(msg.id).split(":")[0];
          if (wsKey !== viewRef.current) setUnread((u) => (u.has(wsKey) ? u : new Set(u).add(wsKey)));
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

  useEffect(() => {
    viewRef.current = view;
    if (view) localStorage.setItem("qualitylab.view", view);
    setUnread((u) => {
      if (!u.has(view)) return u;
      const next = new Set(u);
      next.delete(view);
      return next;
    });
  }, [view]);

  useEffect(() => {
    localStorage.setItem("qualitylab.unread", JSON.stringify([...unread]));
  }, [unread]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 1600);
    return () => clearTimeout(t);
  }, [toast]);

  // ⌘S — toggle the sidebar; ⌘B — toggle the right panel. In the desktop app the native menu owns the
  // shortcut (it works even with a terminal/browser pane focused) and tells
  // us via an event; in a plain browser tab we catch the key ourselves.
  useEffect(() => {
    if ("__TAURI_INTERNALS__" in window) {
      let unlisten: (() => void) | undefined;
      let cancelled = false;
      void import("@tauri-apps/api/event").then(({ listen }) =>
        Promise.all([
          listen("menu:toggle-sidebar", () => toggleSideRef.current()),
          listen("menu:toggle-right", () => toggleRightRef.current()),
        ]).then((fns) => {
          if (cancelled) fns.forEach((fn) => fn());
          else unlisten = () => fns.forEach((fn) => fn());
        }),
      );
      return () => {
        cancelled = true;
        unlisten?.();
      };
    }
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "s" || key === "b") {
        e.preventDefault();
        e.stopPropagation();
        (key === "s" ? toggleSideRef : toggleRightRef).current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // ⌘⇧⌫ — delete the active workspace (asks first).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.shiftKey && e.key === "Backspace" && config?.repos[viewRef.current]) {
        e.preventDefault();
        e.stopPropagation();
        setDeleteError("");
        setConfirmDelete(viewRef.current);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [config]);

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
      if (view === "connections" || view === "jira") return;
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
      if (view === "connections" || view === "jira") return;
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

  const onWorkspaceAdded = (key: string, repo: RepoInfo) => {
    setConfig((c) => (c ? { ...c, repos: { ...c.repos, [key]: repo } } : c));
    const id = newTabId(key);
    setTabs((prev) => ({ ...prev, [key]: [{ id, title: "shell" }] }));
    setActiveTab((prev) => ({ ...prev, [key]: id }));
    setView(key);
    setAdding(false);
  };

  const removeWs = async (key: string, alreadyRemoved = false) => {
    setConfirmRemove(null);
    if (!alreadyRemoved) await api(`/api/workspaces/${key}`, { method: "DELETE" });
    if ("__TAURI_INTERNALS__" in window) {
      const { invoke } = await import("@tauri-apps/api/core");
      let ids = [1];
      try {
        ids = JSON.parse(localStorage.getItem(`qualitylab.browserTabs.${key}`) ?? "null")?.tabs?.map((t: { id: number }) => t.id) ?? ids;
      } catch {
        /* keep default */
      }
      for (const id of ids) {
        const label = id === 1 ? browserLabel(key) : `${browserLabel(key)}-t${id}`;
        void invoke("browser_close", { label }).catch(() => undefined);
      }
      localStorage.removeItem(`qualitylab.browserTabs.${key}`);
    }
    for (const t of tabs[key] ?? []) {
      send({ type: "term:kill", id: t.id });
      disposeTerm(t.id);
    }
    setTabs(({ [key]: _gone, ...rest }) => rest);
    const { [key]: _removed, ...repos } = config?.repos ?? {};
    if (view === key) setView(Object.keys(repos)[0] ?? "");
    setConfig((c) => (c ? { ...c, repos } : c));
  };

  const renameWs = async (key: string, label: string) => {
    setRenaming(null);
    const trimmed = label.trim();
    if (!trimmed || trimmed === config?.repos[key]?.label) return;
    // Optimistic: the sidebar updates at once, the server persists it.
    await patchWs(key, { label: trimmed });
  };

  const copyText = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setToast(`Copied ${what}`);
  };

  // color: null clears the colour (the server drops the field).
  const patchWs = (key: string, patch: Partial<Omit<RepoInfo, "color">> & { color?: string | null }) => {
    setConfig((c) => {
      if (!c) return c;
      const { color, ...rest } = patch;
      const next: RepoInfo = { ...c.repos[key], ...rest };
      if (color === null) delete next.color;
      else if (color !== undefined) next.color = color;
      return { ...c, repos: { ...c.repos, [key]: next } };
    });
    return api(`/api/workspaces/${key}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  };

  const trashWs = async (key: string) => {
    setDeleteError("");
    const r = await api(`/api/workspaces/${key}/trash`, { method: "POST" });
    if (!r.ok) {
      setDeleteError((await r.json()).error ?? "Delete failed");
      return;
    }
    setConfirmDelete(null);
    await removeWs(key, true);
    setToast("Moved to Trash");
  };

  const menuGroups = (key: string) => {
    const r = config!.repos[key];
    return [
      [
        { label: r.pinned ? "Unpin" : "Pin", icon: r.pinned ? MenuIcons.unpin : MenuIcons.pin, onSelect: () => patchWs(key, { pinned: !r.pinned }) },
        { label: "Rename", icon: MenuIcons.rename, onSelect: () => setRenaming(key) },
      ],
      [
        { label: "Open in Finder", icon: MenuIcons.folder, onSelect: () => api(`/api/workspaces/${key}/reveal`, { method: "POST" }) },
        { label: "Copy Path", icon: MenuIcons.copy, onSelect: () => copyText(r.path, "path") },
        {
          label: "Copy Branch Name",
          icon: MenuIcons.branch,
          onSelect: async () => {
            const res = await api(`/api/workspaces/${key}/branch`);
            const body = await res.json();
            if (res.ok) copyText(body.branch, `branch ${body.branch}`);
            else setToast(body.error ?? "No branch");
          },
        },
      ],
      [
        unread.has(key)
          ? { label: "Mark as Read", icon: MenuIcons.read, onSelect: () => setUnread((u) => { const n = new Set(u); n.delete(key); return n; }) }
          : { label: "Mark as Unread", icon: MenuIcons.unread, onSelect: () => setUnread((u) => new Set(u).add(key)) },
      ],
      [
        { label: "Remove from Sidebar", icon: MenuIcons.remove, onSelect: () => setConfirmRemove(key) },
        {
          label: "Delete",
          icon: MenuIcons.trash,
          danger: true,
          shortcut: "⌘⇧⌫",
          onSelect: () => {
            setDeleteError("");
            setConfirmDelete(key);
          },
        },
      ],
    ];
  };

  revealBrowserRef.current = (ws: string) => {
    if (ws !== viewRef.current) return;
    if (rightHidden) hideRight(false);
    if (panelTabs[ws] !== "browser") setPanelTab(ws, "browser");
  };

  toggleRightRef.current = () => {
    if (viewRef.current && viewRef.current !== "connections" && viewRef.current !== "jira") hideRight(!rightHidden);
  };

  const hideRight = (hidden: boolean) => {
    setRightHidden(hidden);
    localStorage.setItem("qualitylab.rightHidden", hidden ? "1" : "0");
  };

  if (!config) return <div className="loading">Loading QualityLab…</div>;

  const isSpecialView = view === "connections" || view === "jira";
  const repo = !isSpecialView ? config.repos[view] : undefined;
  const isTestRepo = repo && (repo.kind === "playwright" || repo.kind === "pytest");
  // Every workspace has a panel now — at minimum the browser.
  const hasPanel = !!repo;
  const panelHidden = rightHidden || !hasPanel;
  const panelTabList: [string, string][] = repo
    ? repo.kind === "mkdocs"
      ? [["preview", "Doc preview"], ["browser", "Browser"]]
      : isTestRepo
        ? [["tree", "Tests"], ["coverage", "Coverage"], ["browser", "Browser"]]
        : [["browser", "Browser"]]
    : [];
  const panelTab = panelTabList.some(([k]) => k === panelTabs[view]) ? panelTabs[view] : panelTabList[0]?.[0];
  // Native browser views float above HTML: hide them under overlays.
  const overlayOpen = adding || !!menu || !!confirmDelete || !!agentDrag || dragging || !!jiraMenu;
  const viewSplits = !isSpecialView ? splits[view] ?? [] : [];
  const splitInfos = viewSplits
    .map((id) => (tabs[view] ?? []).find((t) => t.id === id))
    .filter(Boolean) as TermTab[];
  const canSplit = viewSplits.length < 2;

  return (
    <div className="app">
      <header className="topbar">
        <button className="side-toggle" title={sideHidden ? "Show sidebar (⌘S)" : "Hide sidebar (⌘S)"} onClick={toggleSide}>
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
            <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
            <path d="M6 2.5v11" />
          </svg>
        </button>
        <span className="brand">
          <img src="/giraffe.png" alt="QualityLab" className="brand-logo" />
        </span>
        <span className="workspace-label">{repo ? repo.label : view === "connections" ? "Connections" : view === "jira" ? "Jira" : ""}</span>
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
        <nav
          className={`sidebar ${sideHidden ? "collapsed" : ""}`}
          onTransitionEnd={(e) => {
            if (e.propertyName === "width") window.dispatchEvent(new Event("resize"));
          }}
        >
          <div className="side-section side-section-row">
            <span>Workspaces</span>
            <button className="side-add" title="Add workspace" onClick={() => setAdding(true)}>
              +
            </button>
          </div>
          {Object.entries(config.repos)
            .sort(([, a], [, b]) => Number(!!b.pinned) - Number(!!a.pinned))
            .map(([key, r]) =>
            confirmRemove === key ? (
              <div key={key} className="side-confirm">
                <span>Remove {r.label}?</span>
                <button className="danger" onClick={() => removeWs(key)}>Remove</button>
                <button onClick={() => setConfirmRemove(null)}>Keep</button>
              </div>
            ) : renaming === key ? (
              <div key={key} className="side-item active renaming">
                <span className="avatar" style={avatarStyle(r)}>
                  {r.label[0]?.toUpperCase()}
                </span>
                <input
                  className="side-rename"
                  defaultValue={r.label}
                  autoFocus
                  onFocus={(e) => e.currentTarget.select()}
                  onKeyDown={(e) => {
                    // Enter commits via blur; Escape restores the old name first.
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") {
                      e.currentTarget.value = r.label;
                      e.currentTarget.blur();
                    }
                  }}
                  onBlur={(e) => renameWs(key, e.currentTarget.value)}
                />
              </div>
            ) : (
              <div
                key={key}
                className={`side-item ${view === key ? "active" : ""}`}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ key, x: e.clientX, y: e.clientY });
                }}
              >
                <button
                  className="side-item-main"
                  onClick={() => {
                    setView(key);
                                    setUnread((u) => {
                      if (!u.has(key)) return u;
                      const n = new Set(u);
                      n.delete(key);
                      return n;
                    });
                  }}
                >
                  <span className="avatar" style={avatarStyle(r)}>
                    {r.label[0]?.toUpperCase()}
                  </span>
                  <span className="side-label">{r.label}</span>
                  {r.pinned && <span className="side-pin" title="Pinned">{MenuIcons.pin}</span>}
                  {unread.has(key) && <span className="unread-dot" title="New activity" />}
                </button>
                <button className="side-remove" title="Remove workspace (files stay on disk)" onClick={() => setConfirmRemove(key)}>
                  ×
                </button>
              </div>
            ),
          )}
          {Object.keys(config.repos).length === 0 && (
            <button className="side-item side-empty" onClick={() => setAdding(true)}>
              <span className="avatar">+</span>
              <span className="side-label">Add a repo folder</span>
            </button>
          )}
          <button
            className={`side-section side-section-toggle ${viewsHidden ? "collapsed" : ""}`}
            onClick={toggleViews}
            title={viewsHidden ? "Show views" : "Hide views"}
          >
            <span>Views</span>
            <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2.5 3.75 5 6.25l2.5-2.5" />
            </svg>
          </button>
          <div className={`side-views ${viewsHidden ? "collapsed" : ""}`}>
            <div className="side-views-inner">
              <button
                className={`side-item view-item ${view === "connections" ? "active" : ""}`}
                onClick={() => setView("connections")}
                tabIndex={viewsHidden ? -1 : 0}
              >
                <span className="avatar view-icon"><WebIcon /></span>
                <span className="side-label">Connections</span>
              </button>
              <button
                className={`side-item view-item ${view === "jira" ? "active" : ""} ${jiraMenu ? "menu-open" : ""}`}
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  setJiraMenu((m) => (m ? null : rect));
                }}
                tabIndex={viewsHidden ? -1 : 0}
              >
                <span className="avatar view-icon"><JiraIcon /></span>
                <span className="side-label">Jira</span>
              </button>
            </div>
          </div>
          <div className="side-footer">
            <span className="avatar">{(config.user ?? "?")[0].toUpperCase()}</span> {config.user} · QualityLab 0.1
          </div>
        </nav>
        {!repo && !isSpecialView ? (
          <section className="full-pane empty-state">
            <img src="/giraffe.png" alt="" className="empty-logo" />
            <h2>Add your QA repos</h2>
            <p>
              Point QualityLab at the folders you already have: product docs, Playwright E2E, pytest API, the dashboard
              and backend repos. Each folder's type is detected and gets the right panel: docs preview, test tree and
              coverage, or just terminals and a browser.
            </p>
            <button className="primary" onClick={() => setAdding(true)}>
              + Add workspace
            </button>
            <ol className="empty-steps">
              <li>Add each repo folder with <b>+</b> (they stay where they are; nothing is copied)</li>
              <li>Add the dashboard and backend repos too to unlock <b>Connections</b></li>
              <li>Open a terminal, click <b>Claude</b> or <b>Codex</b>, and work</li>
            </ol>
            <SetupChecklist />
          </section>
        ) : view === "connections" ? (
          <section className="full-pane">
            <FeatureMap onAddWorkspace={() => setAdding(true)} />
          </section>
        ) : view === "jira" ? (
          <section className="full-pane jira-pane">
            {jiraBoards.length === 0 && !jiraOpen ? (
              <div className="jira-empty">
                <JiraIcon />
                <h2>Jira inside QualityLab</h2>
                <p>Save the boards, backlogs, filters or issues you use, then open them here next to your terminals. Your Atlassian login stays signed in.</p>
                <button className="primary" onClick={(e) => setJiraMenu(e.currentTarget.getBoundingClientRect())}>
                  + Add a Jira link
                </button>
              </div>
            ) : (
              <Browser
                wsKey="jira"
                visible={!overlayOpen}
                defaultUrl={jiraBoards[0]?.url ?? jiraOpen?.url}
                bookmarks={jiraBoards}
                openRequest={jiraOpen}
              />
            )}
          </section>
        ) : (
          <div
            className={`panes ${dragging ? "dragging" : ""}`}
            ref={panesRef}
            style={{ gridTemplateColumns: panelHidden ? "1fr 0px 0fr" : `${split}fr 6px ${100 - split}fr` }}
            onTransitionEnd={(e) => {
              // Settle terminals and panels at the final size once the slide
              // finishes — mid-animation fits leave xterm garbled otherwise.
              if (e.propertyName === "grid-template-columns") {
                window.dispatchEvent(new Event("resize"));
              }
            }}
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
              className={`splitter ${panelHidden ? "collapsed" : ""}`}
              onPointerDown={panelHidden ? undefined : onSplitDown}
              title="Drag to resize"
            />
            {
              <section className={`right ${panelHidden ? "collapsed" : ""}`}>
                {repo && (
                  <>
                    <nav className="tabs">
                      {panelTabList.map(([k, name]) => (
                        <button key={k} className={panelTab === k ? "active" : ""} onClick={() => setPanelTab(view, k)}>
                          {name}
                        </button>
                      ))}
                      <button className="pane-collapse" title="Hide panel (⌘B)" onClick={() => hideRight(true)}>»</button>
                    </nav>
                    {panelTab === "preview" && <Preview key={view} wsKey={view} />}
                    {panelTab === "tree" && <TestTree repo={view} />}
                    {panelTab === "coverage" && (
                      <SuiteCoverage key={view} suite={repo.kind === "pytest" ? "api" : "e2e"} repoKey={view} />
                    )}
                    {panelTab === "browser" && <Browser key={view} wsKey={view} visible={!panelHidden && !overlayOpen} />}
                  </>
                )}
              </section>
            }
            {rightHidden && hasPanel && (
              <button className="pane-reopen" title="Show panel (⌘B)" onClick={() => hideRight(false)}>
                «
              </button>
            )}
          </div>
        )}
      </div>
      {menu && config.repos[menu.key] && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          groups={menuGroups(menu.key)}
          onClose={() => setMenu(null)}
          top={
            <div className="ctx-swatches" role="group" aria-label="Workspace colour">
              <button
                className={`ctx-swatch none ${!config.repos[menu.key].color ? "on" : ""}`}
                title="No colour"
                onClick={() => {
                  void patchWs(menu.key, { color: null });
                  setMenu(null);
                }}
              />
              {WORKSPACE_COLORS.map((c) => (
                <button
                  key={c}
                  className={`ctx-swatch ${config.repos[menu.key].color === c ? "on" : ""}`}
                  style={{ background: c }}
                  title={c}
                  onClick={() => {
                    void patchWs(menu.key, { color: c });
                    setMenu(null);
                  }}
                />
              ))}
            </div>
          }
        />
      )}
      {confirmDelete && config.repos[confirmDelete] && (
        <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && setConfirmDelete(null)}>
          <div className="modal confirm-modal" role="alertdialog">
            <div className="modal-head">
              <span>Delete {config.repos[confirmDelete].label}?</span>
            </div>
            <div className="confirm-body">
              <p>This moves the folder to the Trash and removes it from QualityLab. You can restore it from the Trash.</p>
              <code>{config.repos[confirmDelete].path}</code>
              {deleteError && <div className="modal-error">{deleteError}</div>}
            </div>
            <div className="modal-foot">
              <span className="modal-path" />
              <button onClick={() => setConfirmDelete(null)} autoFocus>Cancel</button>
              <button className="danger-solid" onClick={() => trashWs(confirmDelete)}>Move to Trash</button>
            </div>
          </div>
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
      {jiraMenu && (
        <JiraMenu
          anchor={jiraMenu}
          boards={jiraBoards}
          onBoards={(next) => {
            setJiraBoards(next);
            saveJiraBoards(next);
          }}
          onOpen={(url) => {
            setJiraMenu(null);
            setView("jira");
            setJiraOpen({ url, nonce: Date.now() });
          }}
          onClose={() => setJiraMenu(null)}
        />
      )}
      {adding && <AddWorkspace onClose={() => setAdding(false)} onAdded={onWorkspaceAdded} />}
      {agentDrag && (
        <div className="drag-ghost" style={{ left: agentDrag.x, top: agentDrag.y }}>
          {agentDrag.cmd === "claude" ? <ClaudeLogo /> : <CodexLogo />} {agentDrag.cmd}
        </div>
      )}
    </div>
  );
}
