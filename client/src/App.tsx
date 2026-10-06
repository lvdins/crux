import { Fragment, useCallback, useEffect, useRef, useState } from "react";
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
import GitMenu, { type GitAction } from "./components/GitMenu";
import {
  MAIN,
  MAX_PANES,
  addTabToPane,
  insertAt,
  leafIds,
  paneActive,
  paneTabs,
  removeTab,
  rootLayout,
  setPaneActive,
  setSizesAt,
  sideAt,
  splitTabIds,
  type DropSide,
  type PaneNode,
} from "./paneLayout";
import JiraMenu, { loadJiraBoards, saveJiraBoards, nameForJiraUrl } from "./components/JiraMenu";
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

/** Where a dragged agent would land: beside a pane, or as a tab. */
interface Drop {
  paneId: string;
  side: DropSide | "center";
  rect: DOMRect;
}

interface JiraTab {
  id: number;
  url: string;
  title: string;
}
const JIRA_TABS_KEY = "qualitylab.browserTabs.jira";
function readJiraTabs(): { tabs: JiraTab[]; active: number } {
  try {
    const saved = JSON.parse(localStorage.getItem(JIRA_TABS_KEY) ?? "null");
    if (Array.isArray(saved?.tabs)) return { tabs: saved.tabs, active: saved.active ?? saved.tabs[0]?.id ?? 1 };
  } catch {
    /* corrupt */
  }
  return { tabs: [], active: 1 };
}
const jiraTabLabel = (id: number) => (id === 1 ? browserLabel("jira") : `${browserLabel("jira")}-t${id}`);

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
  // Terminal pane layout per workspace (split tree; MAIN = tab-strip pane).
  const [layouts, setLayouts] = useState<Record<string, PaneNode>>({});
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
  const [gitMenu, setGitMenu] = useState<null | { anchor: DOMRect; mode: "agent" | "shell"; tabId: string }>(null);
  const [branches, setBranches] = useState<Record<string, string | null>>({});
  const [jiraBoards, setJiraBoards] = useState(loadJiraBoards);
  const [jiraOpen, setJiraOpen] = useState<{ url: string; nonce: number } | null>(null);
  // Open Jira tabs, mirrored from the Jira browser (and localStorage when it isn't mounted).
  const [jiraTabs, setJiraTabs] = useState<{ tabs: JiraTab[]; active: number }>(() => readJiraTabs());
  const [jiraTabsHidden, setJiraTabsHidden] = useState(() => localStorage.getItem("qualitylab.jiraTabsHidden") === "1");
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
  const [agentDrag, setAgentDrag] = useState<null | { cmd: "claude" | "codex"; x: number; y: number; drop: Drop | null }>(null);
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

  useEffect(() => {
    const onTabs = (e: Event) => {
      const d = (e as CustomEvent<{ wsKey: string; tabs: JiraTab[]; active: number }>).detail;
      if (d.wsKey === "jira") setJiraTabs({ tabs: d.tabs, active: d.active });
    };
    window.addEventListener("ql:browser-tabs", onTabs);
    return () => window.removeEventListener("ql:browser-tabs", onTabs);
  }, []);

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
      setLayouts((prev) => (prev[repo] ? { ...prev, [repo]: removeTab(prev[repo], id) } : prev));
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

  const dropAt = useCallback(
    (clientX: number, clientY: number): Drop | null => {
      const pane = document
        .elementsFromPoint(clientX, clientY)
        .find((el): el is HTMLElement => el instanceof HTMLElement && !!el.dataset.paneId);
      if (!pane) return null;
      const rect = pane.getBoundingClientRect();
      let side = sideAt(rect, clientX, clientY);
      const panes = leafIds(layouts[view] ?? rootLayout()).length;
      if (side !== "center" && panes >= MAX_PANES) side = "center";
      return { paneId: pane.dataset.paneId!, side, rect };
    },
    [layouts, view],
  );

  const startAgentDrag = useCallback(
    (cmd: "claude" | "codex") => (e: React.PointerEvent) => {
      if (view === "connections" || view === "jira") return;
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      let started = false;
      const move = (ev: PointerEvent) => {
        if (!started && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 6) started = true;
        if (started) setAgentDrag({ cmd, x: ev.clientX, y: ev.clientY, drop: dropAt(ev.clientX, ev.clientY) });
      };
      const up = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        setAgentDrag(null);
        if (!started) {
          launchAgent(cmd); // plain click
          return;
        }
        const drop = dropAt(ev.clientX, ev.clientY);
        if (!drop) return;
        if (drop.side === "center") {
          if (drop.paneId === MAIN) {
            addTab(view, cmd, cmd, cmd);
          } else {
            // Middle of a split pane: becomes a tab in that pane.
            const id = createTab(view, cmd, cmd, cmd);
            setLayouts((prev) => ({ ...prev, [view]: addTabToPane(prev[view] ?? rootLayout(), drop.paneId, id) }));
          }
          return;
        }
        const id = createTab(view, cmd, cmd, cmd);
        setLayouts((prev) => ({ ...prev, [view]: insertAt(prev[view] ?? rootLayout(), drop.paneId, drop.side as DropSide, id) }));
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [view, dropAt, launchAgent, addTab, createTab],
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

  const jiraTabName = (t: JiraTab) => {
    if (t.title) return t.title.split(/ [-–|] /)[0] || t.title;
    const board = jiraBoards.find((b) => b.url.replace(/\/+$/, "") === t.url.replace(/[?#].*$/, "").replace(/\/+$/, ""));
    return board ? board.name : nameForJiraUrl(t.url);
  };

  const openJiraTab = (id: number) => {
    if (view === "jira") {
      window.dispatchEvent(new CustomEvent("ql:browser-cmd", { detail: { wsKey: "jira", op: "activate", id } }));
    } else {
      // Not mounted: pick the tab it will open on, then show Jira.
      const saved = readJiraTabs();
      localStorage.setItem(JIRA_TABS_KEY, JSON.stringify({ tabs: saved.tabs, active: id }));
      setJiraTabs({ tabs: saved.tabs, active: id });
      setView("jira");
    }
  };

  const closeJiraTab = (id: number) => {
    if (view === "jira") {
      window.dispatchEvent(new CustomEvent("ql:browser-cmd", { detail: { wsKey: "jira", op: "close", id } }));
      return;
    }
    const saved = readJiraTabs();
    const tabs = saved.tabs.filter((t) => t.id !== id);
    const active = saved.active === id ? tabs[0]?.id ?? 1 : saved.active;
    localStorage.setItem(JIRA_TABS_KEY, JSON.stringify({ tabs, active }));
    setJiraTabs({ tabs, active });
    if ("__TAURI_INTERNALS__" in window) {
      void import("@tauri-apps/api/core").then(({ invoke }) => invoke("browser_close", { label: jiraTabLabel(id) }).catch(() => undefined));
    }
  };

  const toggleJiraTabs = () =>
    setJiraTabsHidden((h) => {
      localStorage.setItem("qualitylab.jiraTabsHidden", h ? "0" : "1");
      return !h;
    });

  const refreshBranch = useCallback((key: string) => {
    api(`/api/workspaces/${key}/branch`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setBranches((b) => ({ ...b, [key]: d?.branch ?? null })))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (view && view !== "connections" && view !== "jira") refreshBranch(view);
  }, [view, refreshBranch]);

  // Git button: is the active tab running an agent or a plain shell?
  const openGitMenu = async (anchor: DOMRect) => {
    const tabId = activeTab[view];
    const tab = (tabs[view] ?? []).find((t) => t.id === tabId);
    if (!tab) return;
    let mode: "agent" | "shell" = tab.agent ? "agent" : "shell";
    try {
      const r = await api(`/api/term/${encodeURIComponent(tab.id)}/process`);
      if (r.ok) {
        const proc = String((await r.json()).process ?? "");
        if (proc) mode = /claude|codex/i.test(proc) ? "agent" : "shell";
      }
    } catch {
      /* older server: fall back to how the tab was opened */
    }
    refreshBranch(view);
    setGitMenu({ anchor, mode, tabId: tab.id });
  };

  // Type the action into the terminal, then press Enter separately (TUIs
  // like Claude Code treat text+CR in one burst as a paste).
  const runGitAction = (action: GitAction, mode: "agent" | "shell", tabId: string) => {
    const text = mode === "agent" ? action.agent : action.shell;
    send({ type: "term:input", id: tabId, data: text });
    if (mode === "agent" || !action.shellNoEnter) setTimeout(() => send({ type: "term:input", id: tabId, data: "\r" }), 150);
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
  const overlayOpen = adding || !!menu || !!confirmDelete || !!agentDrag || dragging || !!jiraMenu || !!gitMenu;
  const viewLayout = (!isSpecialView && layouts[view]) || rootLayout();
  const viewSplits = splitTabIds(viewLayout);

  // Drag a divider: resize the two panes either side of it.
  const startPaneResize = (e: React.PointerEvent, path: number[], index: number, dir: "row" | "col", sizes: number[]) => {
    e.preventDefault();
    const container = (e.currentTarget as HTMLElement).parentElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const total = sizes.reduce((a, b) => a + b, 0);
    const span = dir === "row" ? rect.width : rect.height;
    const start = dir === "row" ? e.clientX : e.clientY;
    const pair = sizes[index] + sizes[index + 1];
    const move = (ev: PointerEvent) => {
      const delta = (((dir === "row" ? ev.clientX : ev.clientY) - start) / span) * total;
      const a = Math.min(pair - pair * 0.12, Math.max(pair * 0.12, sizes[index] + delta));
      const next = [...sizes];
      next[index] = a;
      next[index + 1] = pair - a;
      setLayouts((prev) => ({ ...prev, [view]: setSizesAt(prev[view] ?? rootLayout(), path, next) }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.dispatchEvent(new Event("resize"));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const renderPane = (node: PaneNode, path: number[]): React.ReactNode => {
    if (node.kind === "split") {
      return (
        <div className={`pane-split ${node.dir}`} key={path.join(".") || "root"}>
          {node.children.map((child, i) => (
            <Fragment key={child.kind === "leaf" ? child.id : `${path.join(".")}.${i}`}>
              {i > 0 && (
                <div
                  className={`pane-divider ${node.dir}`}
                  // Outer dividers stay grabbable where nested ones cross them.
                  style={{ zIndex: 20 - path.length }}
                  onPointerDown={(e) => startPaneResize(e, path, i - 1, node.dir, node.sizes)}
                />
              )}
              <div className="pane-cell" style={{ flexGrow: node.sizes[i], flexBasis: 0 }}>
                {renderPane(child, [...path, i])}
              </div>
            </Fragment>
          ))}
        </div>
      );
    }
    if (node.id === MAIN) {
      const t = (tabs[view] ?? []).find((x) => x.id === activeTab[view] && !viewSplits.includes(x.id));
      return (
        <div className="term-slot" data-pane-id={MAIN} key={MAIN}>
          {t && <Term key={t.id} id={t.id} repo={view} bootCmd={t.bootCmd} connected={connected} send={send} subscribe={subscribe} />}
        </div>
      );
    }
    // A split pane with its own tabs.
    const ids = paneTabs(node);
    const activeId = paneActive(node);
    const paneTabList = ids.map((id) => (tabs[view] ?? []).find((x) => x.id === id)).filter(Boolean) as TermTab[];
    const shown = paneTabList.find((x) => x.id === activeId) ?? paneTabList[paneTabList.length - 1];
    if (!shown) return null;
    return (
      <div className="term-slot split" data-pane-id={node.id} key={node.id}>
        <div className="term-slot-head">
          <div className="pane-tabs">
            {paneTabList.map((t) => (
              <span
                key={t.id}
                className={`pane-tab ${t.id === shown.id ? "on" : ""}`}
                onClick={() => setLayouts((prev) => ({ ...prev, [view]: setPaneActive(prev[view] ?? rootLayout(), node.id, t.id) }))}
              >
                {t.agent === "claude" && <ClaudeLogo />}
                {t.agent === "codex" && <CodexLogo />}
                <span className="pane-tab-title">{t.title}</span>
                <button
                  className="term-tab-close"
                  title="Close this terminal"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(view, t.id);
                  }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <button
            className="pane-tab-add"
            title="New terminal in this pane"
            onClick={() => {
              const id = createTab(view);
              setLayouts((prev) => ({ ...prev, [view]: addTabToPane(prev[view] ?? rootLayout(), node.id, id) }));
            }}
          >
            +
          </button>
        </div>
        <Term key={shown.id} id={shown.id} repo={view} bootCmd={shown.bootCmd} connected={connected} send={send} subscribe={subscribe} />
      </div>
    );
  };

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
                data-menu-anchor="jira"
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  setJiraMenu((m) => (m ? null : rect));
                }}
                tabIndex={viewsHidden ? -1 : 0}
              >
                <span className="avatar view-icon"><JiraIcon /></span>
                <span className="side-label">Jira</span>
                {jiraTabs.tabs.length > 0 && (
                  <span
                    className={`side-sub-toggle ${jiraTabsHidden ? "collapsed" : ""}`}
                    role="button"
                    title={jiraTabsHidden ? "Show open Jira tabs" : "Hide open Jira tabs"}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleJiraTabs();
                    }}
                  >
                    <small>{jiraTabs.tabs.length}</small>
                    <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M2.5 3.75 5 6.25l2.5-2.5" />
                    </svg>
                  </span>
                )}
              </button>
              <div className={`side-sub ${jiraTabsHidden || jiraTabs.tabs.length === 0 ? "collapsed" : ""}`}>
                <div className="side-sub-inner">
                  {jiraTabs.tabs.map((t) => (
                    <div
                      key={t.id}
                      className={`side-sub-item ${view === "jira" && jiraTabs.active === t.id ? "active" : ""}`}
                      onClick={() => openJiraTab(t.id)}
                    >
                      <span className="side-sub-dot" />
                      <span className="side-sub-label">{jiraTabName(t)}</span>
                      <button
                        className="side-remove"
                        title="Close tab"
                        onClick={(e) => {
                          e.stopPropagation();
                          closeJiraTab(t.id);
                        }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              </div>
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
                <button
                  className={`git-btn ${gitMenu ? "on" : ""}`}
                  data-menu-anchor="git"
                  title="Git actions for the active terminal"
                  onClick={(e) => {
                    if (gitMenu) return setGitMenu(null);
                    void openGitMenu(e.currentTarget.getBoundingClientRect());
                  }}
                >
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                    <circle cx="4.5" cy="3.5" r="1.5" />
                    <circle cx="4.5" cy="12.5" r="1.5" />
                    <circle cx="11.5" cy="5" r="1.5" />
                    <path d="M4.5 5v6M11.5 6.5c0 3-7 2-7 4.5" />
                  </svg>
                  <span className="git-btn-branch">{branches[view] ?? "Git"}</span>
                  <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2.5 3.75 5 6.25l2.5-2.5" />
                  </svg>
                </button>
              </div>
              <div className="term-slots">{renderPane(viewLayout, [])}</div>
              {agentDrag?.drop && termPaneRef.current && (
                <DropPreview drop={agentDrag.drop} host={termPaneRef.current.getBoundingClientRect()} />
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
      {gitMenu && (
        <GitMenu
          anchor={gitMenu.anchor}
          mode={gitMenu.mode}
          branch={branches[view] ?? null}
          onPick={(a) => runGitAction(a, gitMenu.mode, gitMenu.tabId)}
          onClose={() => setGitMenu(null)}
        />
      )}
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

const SIDE_LABEL: Record<DropSide | "center", string> = {
  left: "Split left",
  right: "Split right",
  top: "Split up",
  bottom: "Split down",
  center: "Open as new tab",
};

/** Highlights where a dragged agent will land, relative to the terminal area. */
function DropPreview({ drop, host }: { drop: Drop; host: DOMRect }) {
  const r = drop.rect;
  const box = { left: r.left - host.left, top: r.top - host.top, width: r.width, height: r.height };
  if (drop.side === "left") box.width /= 2;
  if (drop.side === "right") {
    box.left += r.width / 2;
    box.width /= 2;
  }
  if (drop.side === "top") box.height /= 2;
  if (drop.side === "bottom") {
    box.top += r.height / 2;
    box.height /= 2;
  }
  return (
    <div className="drop-preview" style={box}>
      <span>{SIDE_LABEL[drop.side]}</span>
    </div>
  );
}
