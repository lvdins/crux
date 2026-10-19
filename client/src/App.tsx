import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QA_SETTINGS, type AppConfig, type RepoInfo, type Settings } from "./types";
import { api, WS_URL } from "./net";
import Term, { disposeTerm, focusTerm } from "./components/Term";
import Preview from "./components/Preview";
import TestTree from "./components/TestTree";
import SuiteCoverage from "./components/SuiteCoverage";
import Browser from "./components/Browser";
import { runAgentCommand, browserLabel, activeBrowserLabel } from "./agentBrowser";
import { CANCEL_REPORT_SCRIPT, REPORT_SCRIPT, cropShot, jiraPrompt, type MarkedIssue } from "./reportIssue";
import ChatSearch, { type PaletteItem, type PastChat } from "./components/ChatSearch";
import ChatPicker from "./components/ChatPicker";
import PipelinesPanel, { overallTone, type PipelineInfo } from "./components/PipelinesPanel";
import FeatureMap from "./components/FeatureMap";
import Home, { reviewPrompt, type InboxMr } from "./components/Home";
import AddWorkspace from "./components/AddWorkspace";
import SetupChecklist, { setupIssues } from "./components/SetupChecklist";
import Intro from "./components/onboarding/Intro";
import Welcome from "./components/onboarding/Welcome";
import NameStep from "./components/onboarding/NameStep";
import ModeStep from "./components/onboarding/ModeStep";
import { useModalKeys } from "./useModalKeys";
import SettingsModal, { PAGES as SETTINGS_PAGES, type Page as SettingsPage } from "./components/SettingsModal";
import { notify } from "./notify";
import { IS_MAC, KEY, isAppShortcut } from "./platform";
import type { TeamMember, TrayAgent } from "./components/TrayPanel";
import OrchestrateModal, { type OrchestrateOpts } from "./components/OrchestrateModal";
import SessionBar, { type SessionTab } from "./components/SessionBar";
import SessionsPanel from "./components/SessionsPanel";
import WorkspaceHome from "./components/WorkspaceHome";
import "./components/settings.css";
import FirstSetup from "./components/onboarding/FirstSetup";
import PermissionsStep from "./components/onboarding/PermissionsStep";
import "./components/onboarding/onboarding.css";
import GitMenu, { branchSwitchText, type GitAction } from "./components/GitMenu";
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
import ContextMenu, { MenuIcons } from "./components/ContextMenu";
import { WebIcon, ClaudeLogo, CodexLogo, GlobeIcon, OrchestrateIcon, TerminalIcon } from "./components/icons";

const CHIP_COLORS: Record<string, string> = {
  mkdocs: "#d9a05b",
  playwright: "#7ec98f",
  pytest: "#6fa8dc",
  frontend: "#e8a0bf",
  backend: "#9fc5b0",
  generic: "#b4a7d6",
};

type View = string | "connections" | "jira" | "home";
/** Views that are not a workspace. */
const SPECIAL_VIEWS = new Set(["connections", "jira", "home", "sessions"]);
const isSpecial = (v: string) => SPECIAL_VIEWS.has(v);
/** Sent by the ⌥Space quick-ask window. */
type QuickAsk = { ws: string; text: string; agent?: "claude" | "codex" };
/** From Claude's hooks (working / stop / input) or Codex's output (codex-*). */
type AgentEvent = "stop" | "input" | "working" | "codex" | "codex-working";
const IN_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const invokeTauri = (cmd: string, args?: Record<string, unknown>) =>
  IN_TAURI ? import("@tauri-apps/api/core").then(({ invoke }) => invoke(cmd, args)).catch(() => undefined) : Promise.resolve();

/** What the top-bar launchers drag: an agent, or a plain terminal. */
type DragCmd = "claude" | "codex" | "shell";

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
const JIRA_TABS_KEY = "crux.browserTabs.jira";
/** One browser everywhere: the Browser view, every workspace's panel and the
 *  agents' browser tools share its tabs (key "jira" for older saved tabs). */
const SHARED_BROWSER = "jira";
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
  /** Orchestrator mode: the lead chat's agent, or a worker it started. */
  role?: "lead" | "worker";
}

let tabSeq = 1;
const newTabId = (repo: string) => `${repo}:${tabSeq++}:${Date.now() % 100000}`;

// Claude chats get their own session id, so after a restart the server can
// reopen them with `claude --resume <id>` instead of an empty chat.
const agentBoot = (cmd: string) => (cmd === "claude" ? `claude --session-id ${crypto.randomUUID()}` : cmd);

// Open chats (names, kinds, splits) are remembered across restarts.
const SESSION_KEY = "crux.session";
/** Set once the Permissions step was shown (onboarding, or once after updating). */
const PERMS_SEEN = "crux.permissionsSeen";
interface SavedSession {
  tabs: Record<string, TermTab[]>;
  activeTab: Record<string, string>;
  layouts: Record<string, PaneNode>;
  activeChat?: Record<string, string>;
  chatTitles?: Record<string, string>;
  /** Session tab bar order (chat keys). */
  chatOrder?: string[];
}

// A chat is one screen inside a workspace: its own tabs and splits. Tab,
// active-tab and layout state are keyed by chat ("<workspace>::<id>").
const wsOf = (chat: string) => chat.split("::")[0];
const newChatKey = (ws: string) => `${ws}::${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
function loadSession(): SavedSession | null {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null");
    return s?.tabs ? s : null;
  } catch {
    return null;
  }
}

const FINISHED = new Set(["success", "failed", "canceled", "skipped"]);
/**
 * A scheduled run that newly finished as failed → notification. Run ids
 * already seen live in localStorage; the first look at a schedule only
 * records its latest run.
 */
function notifyNewFailures(ws: string, info: PipelineInfo, enabled: boolean, label: string) {
  let seen: Record<string, number> = {};
  try {
    seen = JSON.parse(localStorage.getItem("crux.seenRuns") ?? "{}");
  } catch {
    /* start over */
  }
  for (const s of info.schedules) {
    const run = s.runs[0];
    if (!s.active || !run || !FINISHED.has(run.status)) continue;
    const key = `${ws}:${s.id}`;
    if (seen[key] === run.id) continue;
    if (enabled && seen[key] !== undefined && run.status === "failed") void notify(`${s.description} failed`, `${label} · scheduled pipeline`);
    seen[key] = run.id;
  }
  try {
    localStorage.setItem("crux.seenRuns", JSON.stringify(seen));
  } catch {
    /* private mode */
  }
}

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const settings = { ...QA_SETTINGS, ...config?.settings };
  // Connections is listed only while at least one of its tabs is on.
  const showConnections = settings.connections && (settings.connCoverage || settings.connGraph);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPage, setSettingsPage] = useState<SettingsPage>("profile");
  // { mode } applies that mode's preset; other keys flip single toggles.
  // Quick clicks send several saves; only the newest reply may replace the
  // local copy, or an older one would undo a switch just flipped.
  const settingsSeq = useRef(0);
  const saveSettings = (patch: Partial<Settings>) => {
    const seq = ++settingsSeq.current;
    setConfig((c) => (c ? { ...c, settings: { ...(c.settings ?? QA_SETTINGS), ...patch } } : c));
    void api("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    })
      .then((r) => r.json())
      .then((s: Settings) => seq === settingsSeq.current && setConfig((c) => (c ? { ...c, settings: s } : c)))
      .catch(() => undefined);
  };
  const [view, setView] = useState<View>("");
  // A view switched off in Settings: leave it.
  useEffect(() => {
    if ((view === "connections" && !showConnections) || (view === "jira" && !settings.jira)) {
      setView(Object.keys(config?.repos ?? {})[0] ?? "");
    }
  }, [view, settings.connections, settings.jira, config]);
  // Right-panel tab per workspace: tree / coverage / preview / browser.
  const [panelTabs, setPanelTabs] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem("crux.panelTabs") ?? "{}");
    } catch {
      return {};
    }
  });
  const setPanelTab = (key: string, tab: string) =>
    setPanelTabs((prev) => {
      const next = { ...prev, [key]: tab };
      localStorage.setItem("crux.panelTabs", JSON.stringify(next));
      return next;
    });
  const [connected, setConnected] = useState(false);
  const [split, setSplit] = useState<number>(() => {
    const saved = Number(localStorage.getItem("crux.split"));
    return saved >= 20 && saved <= 75 ? saved : 42;
  });
  const [dragging, setDragging] = useState(false);
  const [tabs, setTabs] = useState<Record<string, TermTab[]>>({});
  const [activeTab, setActiveTab] = useState<Record<string, string>>({});
  // Terminal pane layout per workspace (split tree; MAIN = tab-strip pane).
  const [layouts, setLayouts] = useState<Record<string, PaneNode>>({});
  // Chat shown per workspace, and chat names (default: first tab's title).
  const [activeChat, setActiveChat] = useState<Record<string, string>>({});
  const [chatTitles, setChatTitles] = useState<Record<string, string>>({});
  // Session tab bar order; chats not in it yet go at the end (order opened).
  const [chatOrder, setChatOrder] = useState<string[]>([]);
  const orderedChats = [...chatOrder.filter((k) => tabs[k]), ...Object.keys(tabs).filter((k) => !chatOrder.includes(k))];
  // Recently closed chats, for ⌘⇧T.
  const closedChats = useRef<{ ws: string; title: string; tabs: TermTab[] }[]>([]);
  const chatsOf = (ws: string) => Object.keys(tabs).filter((k) => wsOf(k) === ws);
  const chatTitle = (chat: string) => chatTitles[chat] ?? tabs[chat]?.[0]?.title ?? "chat";
  // The chat on screen for the current workspace ("" = it has none yet).
  const ck = activeChat[view] && tabs[activeChat[view]] ? activeChat[view] : chatsOf(view)[0] ?? "";
  // The chat new terminals go into: the one on screen, or a new one.
  const chatForNew = () => {
    if (ck) return ck;
    const chat = newChatKey(view);
    setActiveChat((prev) => ({ ...prev, [view]: chat }));
    setChatsOpen((prev) => new Set(prev).add(view));
    return chat;
  };
  // Save open chats once the saved ones are restored (not the empty start).
  const sessionReady = useRef(false);
  useEffect(() => {
    if (!sessionReady.current) return;
    try {
      localStorage.setItem(
        SESSION_KEY,
        JSON.stringify({ tabs, activeTab, layouts, activeChat, chatTitles, chatOrder: orderedChats } satisfies SavedSession),
      );
    } catch {
      /* storage full or blocked: chats just won't be remembered */
    }
  }, [tabs, activeTab, layouts, activeChat, chatTitles, chatOrder]); // eslint-disable-line react-hooks/exhaustive-deps
  const [rightHidden, setRightHidden] = useState(() => localStorage.getItem("crux.rightHidden") === "1");
  const [sideHidden, setSideHidden] = useState(() => localStorage.getItem("crux.sideHidden") === "1");
  const toggleSide = () =>
    setSideHidden((h) => {
      localStorage.setItem("crux.sideHidden", h ? "0" : "1");
      return !h;
    });
  // Agent drove the browser of the workspace on screen: show it.
  const revealBrowserRef = useRef<(ws: string) => void>(() => {});
  const toggleSideRef = useRef(toggleSide);
  const toggleRightRef = useRef<() => void>(() => {});
  const quickAskRef = useRef<(q: QuickAsk) => void>(() => {});
  // ⌘⇧C (app menu, so it works while the page has focus): mark an issue.
  const browserKeyRef = useRef<(op: string) => void>(() => {});
  // Session tab shortcuts (⌘W, ⌘⇧T, ⌘1–9, ⌘⇧[ ]) when a chat has focus.
  const sessionKeyRef = useRef<(op: string) => void>(() => {});
  // Menu shortcuts and the key fallback both land here (see routeKeyRef.current).
  const routeKeyRef = useRef<(op: string) => void>(() => {});
  const sessionTabsRef = useRef<SessionTab[]>([]);
  const [sessionMenu, setSessionMenu] = useState<null | { x: number; y: number }>(null);
  // The workspace new sessions from the tab bar's + go to.
  const lastWs = useRef("");
  const reportIssueRef = useRef<() => void>(() => {});
  const markingRef = useRef(false);
  // Scheduled-pipeline health per E2E / API workspace (sidebar dot).
  const [pipeTone, setPipeTone] = useState<Record<string, "ok" | "bad" | "run">>({});
  // The latest poll's data per workspace (Home → Failed pipelines).
  const [pipeInfo, setPipeInfo] = useState<Record<string, PipelineInfo>>({});
  const pipeWorkspaces = Object.entries(config?.repos ?? {})
    .filter(([, r]) => settings.pipelines && (r.kind === "playwright" || r.kind === "pytest"))
    .map(([k]) => k)
    .join(",");
  const notifyPipeRef = useRef(settings.notifyPipeline);
  notifyPipeRef.current = settings.notifyPipeline;
  const repoLabelRef = useRef<(ws: string) => string>((ws) => ws);
  repoLabelRef.current = (ws) => config?.repos[ws]?.label ?? ws;
  useEffect(() => {
    if (!pipeWorkspaces) {
      setPipeInfo({});
      return setPipeTone({});
    }
    const poll = () =>
      pipeWorkspaces.split(",").forEach((ws) =>
        api(`/api/pipelines/${ws}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((info: PipelineInfo | null) => {
            if (info) notifyNewFailures(ws, info, notifyPipeRef.current, repoLabelRef.current(ws));
            if (info) setPipeInfo((prev) => ({ ...prev, [ws]: info }));
            const tone = overallTone(info);
            setPipeTone((prev) => {
              const { [ws]: _old, ...rest } = prev;
              return tone ? { ...rest, [ws]: tone } : rest;
            });
          })
          .catch(() => undefined),
      );
    poll();
    const timer = setInterval(poll, 10 * 60_000);
    return () => clearInterval(timer);
  }, [pipeWorkspaces]);
  // Marked in the Browser view: the user picks which workspace chat gets it.
  // A screenshot waiting for "which chat gets it": a marked page issue, or a
  // plain screen capture from the menu bar panel (no issue).
  const [shotPick, setShotPick] = useState<null | { path: string; preview: string; issue?: MarkedIssue }>(null);
  // After a marked issue lands in a chat: offer to file it as a Jira bug.
  const [issueBar, setIssueBar] = useState<null | { chat: string; path: string; issue: MarkedIssue }>(null);
  useEffect(() => {
    if (!issueBar) return;
    const t = setTimeout(() => setIssueBar(null), 15_000);
    return () => clearTimeout(t);
  }, [issueBar]);
  // ⌘K chat search (over every workspace).
  const [searchOpen, setSearchOpen] = useState(false);
  const repoList = Object.entries(config?.repos ?? {}).map(([k, r]) => `${k}\t${r.label}`).join("\n");
  const searchWorkspaces = useMemo(
    () => (repoList ? repoList.split("\n").map((l) => ({ ws: l.split("\t")[0], label: l.split("\t")[1] })) : []),
    [repoList],
  );
  // Required tools missing or logged out (dot on the Settings gear).
  const [setupCount, setSetupCount] = useState(0);
  useEffect(() => {
    api("/api/health")
      .then((r) => r.json())
      .then((d) => setSetupCount(setupIssues(d.tools ?? [])))
      .catch(() => undefined);
  }, []);
  toggleSideRef.current = toggleSide;
  const [adding, setAdding] = useState(false);
  // QA setup slots open Add workspace for one kind ("QA Docs" → mkdocs).
  const [addPreset, setAddPreset] = useState<null | { kind: string; title: string }>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  // "+" next to a workspace: pick Claude / Codex / terminal for a new chat.
  const [chatMenu, setChatMenu] = useState<null | { key: string; x: number; y: number }>(null);
  // Name prompt shown before a new chat is created.
  const [nameChat, setNameChat] = useState<null | { key: string; kind: "claude" | "codex" | "shell"; name: string }>(null);
  // First-run intro → welcome cards → guided setup (replayable from the ? button).
  const [onboarding, setOnboarding] = useState<null | "intro" | "name" | "mode" | "permissions" | "welcome" | "setup">(null);
  // Permissions opened on its own (Settings, or once after updating) closes instead of going on to Welcome.
  const permsAlone = useRef(false);
  // Installed app only: newer GitHub release → bubble above the sidebar footer.
  const [appVersion, setAppVersion] = useState("0.1.0");
  const [update, setUpdate] = useState<null | { latest: string; installing: boolean }>(null);
  useEffect(() => {
    if (import.meta.env.DEV || !("__TAURI_INTERNALS__" in window)) return;
    let current = "";
    const check = () =>
      api(`/api/update?current=${current}`)
        .then((r) => r.json())
        .then((u: { latest: string | null; available: boolean }) =>
          setUpdate((prev) => (prev?.installing ? prev : u.available && u.latest ? { latest: u.latest, installing: false } : null)),
        )
        .catch(() => undefined);
    void import("@tauri-apps/api/app").then(async ({ getVersion }) => {
      current = await getVersion();
      setAppVersion(current);
      void check();
    });
    // Crux now stays open for days (menu bar), and macOS pauses timers in a
    // hidden window: check often, and whenever Crux comes back to the front.
    let lastCheck = 0;
    const maybeCheck = () => {
      if (!current || Date.now() - lastCheck < 10 * 60_000) return;
      lastCheck = Date.now();
      void check();
    };
    const timer = setInterval(maybeCheck, 30 * 60_000);
    window.addEventListener("focus", maybeCheck);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", maybeCheck);
    };
  }, []);
  const installUpdate = async () => {
    setUpdate((u) => (u ? { ...u, installing: true } : u));
    const r = await api("/api/update/install", { method: "POST" }).catch(() => null);
    if (!r?.ok) {
      setUpdate((u) => (u ? { ...u, installing: false } : u));
      const err = r ? ((await r.json().catch(() => ({}))) as { error?: string }).error : undefined;
      setToast(err ?? "Update failed");
    }
  };
  // Right-click menu on a chat in the sidebar, and the chat being renamed.
  const [chatCtx, setChatCtx] = useState<null | { key: string; id: string; name: string; x: number; y: number }>(null);
  const [renamingChat, setRenamingChat] = useState<string | null>(null);
  // "Are you sure?" before a chat / terminal is closed.
  // id "" = close the whole chat `key`; otherwise one terminal in it.
  const [confirmClose, setConfirmClose] = useState<null | { key: string; id: string; name: string }>(null);
  const doClose = (c: { key: string; id: string }) => (c.id ? closeTab(c.key, c.id) : closeChat(c.key));
  // Close a chat or terminal, asking first unless that's turned off in Settings.
  const requestClose = (c: { key: string; id: string; name: string }) => (settings.confirmClose ? setConfirmClose(c) : doClose(c));
  // Workspaces whose chat list is unfolded in the sidebar; all start folded.
  const [chatsOpen, setChatsOpen] = useState<Set<string>>(() => new Set());
  const [gitMenu, setGitMenu] = useState<null | { anchor: DOMRect; mode: "agent" | "shell"; tabId: string; target: string }>(null);
  const [branches, setBranches] = useState<Record<string, string | null>>({});
  // Last terminal the user clicked / typed in, per workspace (Git targets it).
  const [focusedTerm, setFocusedTerm] = useState<Record<string, string>>({});
  const noteFocus = useCallback((id: string) => {
    const ws = id.split(":")[0];
    setFocusedTerm((prev) => (prev[ws] === id ? prev : { ...prev, [ws]: id }));
  }, []);
  // Open Jira tabs, mirrored from the Jira browser (and localStorage when it isn't mounted).
  const [jiraTabs, setJiraTabs] = useState<{ tabs: JiraTab[]; active: number }>(() => readJiraTabs());
  // A page to open in the Browser view (Home's "Open" links).
  const [browserOpen, setBrowserOpen] = useState<{ url: string; nonce: number } | null>(null);
  const [jiraTabsHidden, setJiraTabsHidden] = useState(() => localStorage.getItem("crux.jiraTabsHidden") === "1");
  const [menu, setMenu] = useState<null | { key: string; x: number; y: number }>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [toast, setToast] = useState("");
  const [unread, setUnread] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("crux.unread") ?? "[]"));
    } catch {
      return new Set();
    }
  });
  const viewRef = useRef(view);
  // Chats whose agent finished or needs input while you weren't looking.
  const [attention, setAttention] = useState<Map<string, "input" | "stop">>(new Map());
  // Titles of the system notifications sent per chat, so they can be taken down.
  const sentNotes = useRef<Map<string, Set<string>>>(new Map());
  // The Crux window has focus (coming back to a finished chat clears it too).
  const [windowFocused, setWindowFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const on = () => setWindowFocused(true);
    const off = () => setWindowFocused(false);
    window.addEventListener("focus", on);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("focus", on);
      window.removeEventListener("blur", off);
    };
  }, []);
  // Called from the socket handler, so it reads this render's state.
  const agentEventRef = useRef<(term: string, event: AgentEvent, detail?: string) => void>(() => {});
  // Latest line about each chat from Claude's hooks: your prompt, the tool
  // it's running, what it needs, or its last reply (shown in the menu bar).
  const [chatDetail, setChatDetail] = useState<Map<string, string>>(new Map());
  // Orchestrator chats → their workers (from the server), and the dialog.
  const [teams, setTeams] = useState<Map<string, { lead: string; workers: TeamMember[] }>>(new Map());
  const [orchestrate, setOrchestrate] = useState<string | null>(null);
  const orchRef = useRef<(msg: any) => void>(() => {});
  // Menu bar menu → "show me this chat" / "pick who gets this screenshot"
  // (the listeners are set up once).
  const openChatRef = useRef<(chat: string) => void>(() => {});
  const screenshotRef = useRef<(pngBase64: string) => void>(() => {});
  // Chats whose agent is working right now → since when.
  const [working, setWorking] = useState<Map<string, number>>(new Map());
  // The agent tab that reported working, per chat (its output is the signal).
  const workingTab = useRef(new Map<string, string>());
  const tabsRef = useRef<Record<string, TermTab[]>>({});
  tabsRef.current = tabs;
  // Last output per terminal: a "working" agent that has gone quiet (interrupted
  // with Esc, so no Stop hook) stops counting as working.
  const lastOutput = useRef(new Map<string, number>());
  // Codex has no hooks: ≥3 s of output counts as working, then 10 s of quiet as finished.
  const codexQuiet = useRef(new Map<string, { since: number; marked: boolean; timer: ReturnType<typeof setTimeout> }>());
  const [agentDrag, setAgentDrag] = useState<null | { cmd: DragCmd; x: number; y: number; drop: Drop | null }>(null);
  // A chat tab being dragged to another pane or into a new split.
  const [tabDrag, setTabDrag] = useState<null | { tab: TermTab; x: number; y: number; drop: Drop | null }>(null);
  const panesRef = useRef<HTMLDivElement>(null);
  const termPaneRef = useRef<HTMLElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termHandlers = useRef(new Map<string, (data: string) => void>());

  const onSplitDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    setDragging(true);
    // Drag straight on the grid, once per frame, without re-rendering the
    // app; React state is updated once on release.
    const el = panesRef.current;
    const rect = el?.getBoundingClientRect();
    let pct = split;
    let raf = 0;
    const apply = () => {
      raf = 0;
      if (el) el.style.gridTemplateColumns = `${pct}fr 1px ${100 - pct}fr`;
    };
    const move = (ev: PointerEvent) => {
      if (!rect) return;
      pct = Math.min(75, Math.max(20, ((ev.clientX - rect.left) / rect.width) * 100));
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const up = () => {
      if (raf) cancelAnimationFrame(raf);
      apply();
      setDragging(false);
      setSplit(pct);
      localStorage.setItem("crux.split", String(Math.round(pct * 10) / 10));
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.dispatchEvent(new Event("resize"));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, [split]);

  useEffect(() => {
    api("/api/config")
      .then((r) => r.json())
      .then((c: AppConfig) => {
        setConfig(c);
        if (!c.onboarded) setOnboarding("intro");
        // Set up before the Permissions step existed: show it once.
        else if (IN_TAURI && IS_MAC && !localStorage.getItem(PERMS_SEEN)) {
          permsAlone.current = true;
          setOnboarding("permissions");
        }
        const keys = Object.keys(c.repos);
        const last = localStorage.getItem("crux.view");
        const openHome = { ...QA_SETTINGS, ...c.settings }.openHome && keys.length > 0;
        setView(openHome ? "home" : last && (isSpecial(last) || keys.includes(last)) ? last : keys[0] ?? "");
        const initialTabs: Record<string, TermTab[]> = {};
        const initialActive: Record<string, string> = {};
        const initialLayouts: Record<string, PaneNode> = {};
        const initialChat: Record<string, string> = {};
        const initialTitles: Record<string, string> = {};
        const saved = loadSession();
        for (const ws of Object.keys(c.repos)) {
          // Saves from before chats existed are keyed by workspace.
          const keys = Object.keys(saved?.tabs ?? {}).filter((k) => k === ws || wsOf(k) === ws);
          for (const k of keys) {
            const prev = saved!.tabs[k]?.filter((t) => t.id && t.title);
            if (!prev?.length) continue;
            // Older versions opened a "shell" in every workspace by themselves;
            // a chat that is still just that one untouched shell is dropped.
            if (prev.length === 1 && !prev[0].agent && prev[0].title === "shell" && !saved!.chatTitles?.[k]) continue;
            const chat = k === ws ? `${ws}::1` : k;
            // Reopen last session's chats. Codex can't be told which session
            // to reopen, so it shows its "resume" picker.
            initialTabs[chat] = prev.map((t) => (t.agent === "codex" ? { ...t, bootCmd: "codex resume" } : t));
            const ids = new Set(prev.map((t) => t.id));
            initialActive[chat] = ids.has(saved!.activeTab[k]) ? saved!.activeTab[k] : prev[0].id;
            const layout = saved!.layouts[k];
            if (layout && splitTabIds(layout).every((id) => ids.has(id))) initialLayouts[chat] = layout;
            if (saved!.chatTitles?.[k]) initialTitles[chat] = saved!.chatTitles[k];
            // Keep new tab ids from colliding with restored ones.
            for (const t of prev) tabSeq = Math.max(tabSeq, (Number(t.id.split(":").at(-2)) || 0) + 1);
          }
          // No chats is fine: the user starts one when they want it.
          const mine = Object.keys(initialTabs).filter((k) => wsOf(k) === ws);
          const last = saved?.activeChat?.[ws];
          if (mine.length) initialChat[ws] = last && mine.includes(last) ? last : mine[0];
        }
        setTabs(initialTabs);
        setActiveTab(initialActive);
        setLayouts(initialLayouts);
        setActiveChat(initialChat);
        setChatTitles(initialTitles);
        setChatOrder((saved?.chatOrder ?? []).filter((k) => initialTabs[k]));
        sessionReady.current = true;
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
        ws.send(JSON.stringify({ type: "orch:hello" }));
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 2000);
      };
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "browser:cmd") {
          revealBrowserRef.current(msg.ws);
          runAgentCommand(SHARED_BROWSER, msg.op, msg.args ?? {})
            .then((result) => ws.send(JSON.stringify({ type: "browser:result", id: msg.id, ok: true, result })))
            .catch((err) => ws.send(JSON.stringify({ type: "browser:result", id: msg.id, ok: false, error: String(err?.message ?? err) })));
          return;
        }
        if (typeof msg.type === "string" && msg.type.startsWith("orch:")) {
          orchRef.current(msg);
          return;
        }
        if (msg.type === "agent:event") {
          agentEventRef.current(
            String(msg.id),
            msg.event === "input" ? "input" : msg.event === "working" ? "working" : "stop",
            typeof msg.detail === "string" ? msg.detail : "",
          );
          return;
        }
        if (msg.type === "term:data") {
          termHandlers.current.get(msg.id)?.(msg.data);
          const quiet = codexQuiet.current;
          const prev = quiet.get(msg.id);
          if (prev) clearTimeout(prev.timer);
          const since = prev?.since ?? Date.now();
          lastOutput.current.set(String(msg.id), Date.now());
          const marked = !!prev?.marked || Date.now() - since > 3000;
          if (marked && !prev?.marked) agentEventRef.current(String(msg.id), "codex-working");
          quiet.set(msg.id, {
            since,
            marked,
            timer: setTimeout(() => {
              quiet.delete(msg.id);
              if (Date.now() - since > 13_000) agentEventRef.current(String(msg.id), "codex");
            }, 10_000),
          });
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
    if (view) localStorage.setItem("crux.view", view);
    setUnread((u) => {
      if (!u.has(view)) return u;
      const next = new Set(u);
      next.delete(view);
      return next;
    });
  }, [view]);

  useEffect(() => {
    localStorage.setItem("crux.unread", JSON.stringify([...unread]));
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

  // ⌘S — toggle the sidebar; ⌘B — toggle the right panel; ⌘K — search (Ctrl+Shift+… on
  // Linux / Windows). In the macOS app the native menu owns these (they work
  // even with a browser pane focused) and tells us via an event; elsewhere,
  // and in a plain browser tab, we catch the keys ourselves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const hit = (["s", "b", "k"] as const).find((k) => isAppShortcut(e, k));
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation();
      if (hit === "k") setSearchOpen(true);
      else (hit === "s" ? toggleSideRef : toggleRightRef).current();
    };
    const ownKeys = !IN_TAURI || !IS_MAC;
    if (ownKeys) window.addEventListener("keydown", onKey, true);
    const dropKeys = () => ownKeys && window.removeEventListener("keydown", onKey, true);
    if ("__TAURI_INTERNALS__" in window) {
      let unlisten: (() => void) | undefined;
      let cancelled = false;
      void import("@tauri-apps/api/event").then(({ listen }) =>
        Promise.all([
          listen("menu:toggle-sidebar", () => toggleSideRef.current()),
          listen("menu:toggle-right", () => toggleRightRef.current()),
          listen("menu:report-issue", () => reportIssueRef.current()),
          listen<string>("menu:browser", (e) => routeKeyRef.current(e.payload)),
          listen("menu:search-chats", () => setSearchOpen(true)),
          listen("menu:check-updates", () => {
            setSettingsPage("updates");
            setSettingsOpen(true);
          }),
          listen<QuickAsk>("quick:ask", (e) => quickAskRef.current(e.payload)),
          listen<string>("tray:open-chat", (e) => openChatRef.current(e.payload)),
          listen<string>("tray:screenshot", (e) => screenshotRef.current(e.payload)),
        ]).then((fns) => {
          if (cancelled) fns.forEach((fn) => fn());
          else unlisten = () => fns.forEach((fn) => fn());
        }),
      );
      return () => {
        cancelled = true;
        unlisten?.();
        dropKeys();
      };
    }
    return dropKeys;
  }, []);

  // Browser shortcuts typed in Crux's own UI (a terminal, a field): WebKit or
  // xterm can keep some (⌘T, ⌘W) from ever reaching the menu, so catch them
  // here too. On a web page the Browser menu handles them.
  useEffect(() => {
    if (!IN_TAURI || !IS_MAC) return;
    const keys: Record<string, string> = {
      t: "new-tab",
      w: "close",
      l: "url",
      r: "reload",
      f: "find",
      d: "bookmark",
      "[": "back",
      "]": "forward",
      "=": "zoom-in",
      "-": "zoom-out",
      "0": "zoom-reset",
    };
    const onKey = (e: KeyboardEvent) => {
      let op: string | undefined;
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === "Tab") op = e.shiftKey ? "prev-tab-ctrl" : "next-tab-ctrl";
      else if (e.metaKey && !e.ctrlKey && !e.altKey) {
        const k = e.key.toLowerCase();
        op = e.shiftKey ? ({ t: "reopen", d: "duplicate", "]": "next-tab", "}": "next-tab", "[": "prev-tab", "{": "prev-tab" } as Record<string, string>)[k] : keys[k];
        if (!op && !e.shiftKey && /^[1-9]$/.test(k)) op = `tab-${k}`;
      }
      if (!op) return;
      e.preventDefault();
      e.stopPropagation();
      routeKeyRef.current(op);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // ⌘⇧⌫ (Ctrl+Shift+Backspace elsewhere) — delete the active workspace (asks first).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = IS_MAC ? e.metaKey : e.ctrlKey && !e.metaKey;
      if (mod && e.shiftKey && e.key === "Backspace" && config?.repos[viewRef.current]) {
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

  const createTab = useCallback(
    (repo: string, title = "shell", agent?: string, bootCmd?: string, id = newTabId(repo), role?: TermTab["role"]) => {
      setTabs((prev) => ({ ...prev, [repo]: [...(prev[repo] ?? []), { id, title, agent, bootCmd, ...(role && { role }) }] }));
      return id;
    },
    [],
  );

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
          const ws = wsOf(repo);
          const siblings = Object.keys(prev).filter((k) => k !== repo && wsOf(k) === ws);
          // Last tab of this chat: the chat goes (another one is shown, if any).
          delete next[repo];
          setLayouts(({ [repo]: _l, ...rest }) => rest);
          setChatTitles(({ [repo]: _t, ...rest }) => rest);
          setActiveChat((a) => {
            if (a[ws] !== repo) return a;
            if (siblings.length) return { ...a, [ws]: siblings[siblings.length - 1] };
            const { [ws]: _gone, ...rest } = a;
            return rest;
          });
        }
        return next;
      });
    },
    [send],
  );

  const launchAgent = useCallback(
    (cmd: "claude" | "codex") => {
      if (isSpecial(view)) return;
      const repoTabs = tabs[ck] ?? [];
      const active = repoTabs.find((t) => t.id === activeTab[ck]);
      if (active && !active.agent) {
        // Free shell tab: respawn it with the command baked into the shell
        // invocation (typing into a live shell races prompt init — p10k eats
        // typed-ahead input, so we never type commands at all).
        send({ type: "term:kill", id: active.id });
        disposeTerm(active.id);
        const id = newTabId(ck);
        setTabs((prev) => ({
          ...prev,
          [ck]: (prev[ck] ?? []).map((t) =>
            t.id === active.id ? { id, title: cmd, agent: cmd, bootCmd: agentBoot(cmd) } : t,
          ),
        }));
        setActiveTab((prev) => ({ ...prev, [ck]: id }));
      } else {
        // Active tab already hosts an agent (or there's no chat yet): own tab.
        addTab(chatForNew(), cmd, cmd, agentBoot(cmd));
      }
    },
    [view, ck, tabs, activeTab, send, addTab],
  );

  const dropAt = useCallback(
    (clientX: number, clientY: number): Drop | null => {
      const pane = document
        .elementsFromPoint(clientX, clientY)
        .find((el): el is HTMLElement => el instanceof HTMLElement && !!el.dataset.paneId);
      if (!pane) return null;
      const rect = pane.getBoundingClientRect();
      let side = sideAt(rect, clientX, clientY);
      const panes = leafIds(layouts[ck] ?? rootLayout()).length;
      if (side !== "center" && panes >= MAX_PANES) side = "center";
      return { paneId: pane.dataset.paneId!, side, rect };
    },
    [layouts, ck],
  );

  // A dragged terminal is a plain shell; agents boot their command.
  const spawnTab = useCallback(
    (repo: string, cmd: DragCmd, inMain = false) => {
      const make = inMain ? addTab : createTab;
      return cmd === "shell" ? make(repo) : make(repo, cmd, cmd, agentBoot(cmd));
    },
    [addTab, createTab],
  );

  const startAgentDrag = useCallback(
    (cmd: DragCmd) => (e: React.PointerEvent) => {
      if (isSpecial(view)) return;
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
          // plain click
          if (cmd === "shell") addTab(chatForNew());
          else launchAgent(cmd);
          return;
        }
        const drop = dropAt(ev.clientX, ev.clientY);
        if (!drop) return;
        if (drop.side === "center") {
          if (drop.paneId === MAIN) {
            spawnTab(chatForNew(), cmd, true);
          } else {
            // Middle of a split pane: becomes a tab in that pane.
            const id = spawnTab(ck, cmd);
            setLayouts((prev) => ({ ...prev, [ck]: addTabToPane(prev[ck] ?? rootLayout(), drop.paneId, id) }));
          }
          return;
        }
        const id = spawnTab(ck, cmd);
        setLayouts((prev) => ({ ...prev, [ck]: insertAt(prev[ck] ?? rootLayout(), drop.paneId, drop.side as DropSide, id) }));
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [view, ck, dropAt, launchAgent, addTab, spawnTab],
  );

  // Where a dragged tab may go: anywhere but its own pane's middle, and the
  // main strip keeps at least one tab (an empty main pane would show nothing).
  const tabDropOk = (tab: TermTab, drop: Drop | null) => {
    if (!drop) return false;
    const layout = layouts[ck] ?? rootLayout();
    const inSplit = splitTabIds(layout).includes(tab.id);
    const mainTabs = (tabs[ck] ?? []).filter((t) => !splitTabIds(layout).includes(t.id));
    if (drop.side === "center") {
      if (drop.paneId === MAIN) return inSplit;
      const leaf = (function find(n: PaneNode): PaneNode | null {
        return n.kind === "leaf" ? (n.id === drop.paneId ? n : null) : n.children.map(find).find(Boolean) ?? null;
      })(layout);
      return !(leaf?.kind === "leaf" && paneTabs(leaf).includes(tab.id));
    }
    // A split pane's only tab can't be split off from itself.
    const own = drop.paneId !== MAIN && leafIds(layout).includes(drop.paneId) && (function find(n: PaneNode): boolean {
      return n.kind === "leaf" ? n.id === drop.paneId && paneTabs(n).length === 1 && paneTabs(n)[0] === tab.id : n.children.some(find);
    })(layout);
    if (own) return false;
    return inSplit || mainTabs.length > 1;
  };

  const startTabDrag = (tab: TermTab) => (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let started = false;
    const move = (ev: PointerEvent) => {
      if (!started && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 6) started = true;
      if (!started) return;
      const drop = dropAt(ev.clientX, ev.clientY);
      setTabDrag({ tab, x: ev.clientX, y: ev.clientY, drop: tabDropOk(tab, drop) ? drop : null });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setTabDrag(null);
      if (!started) return;
      const drop = dropAt(ev.clientX, ev.clientY);
      if (!drop || !tabDropOk(tab, drop)) return;
      setLayouts((prev) => {
        const root = removeTab(prev[ck] ?? rootLayout(), tab.id);
        let next = root;
        if (drop.side !== "center") next = insertAt(root, drop.paneId, drop.side as DropSide, tab.id);
        else if (drop.paneId !== MAIN) next = addTabToPane(root, drop.paneId, tab.id);
        return { ...prev, [ck]: next };
      });
      // Back in the main strip: show it there. Moved out of it: show another.
      setActiveTab((prev) => {
        if (drop.side === "center" && drop.paneId === MAIN) return { ...prev, [ck]: tab.id };
        if (prev[ck] !== tab.id) return prev;
        const layout = layouts[ck] ?? rootLayout();
        const rest = (tabs[ck] ?? []).filter((t) => t.id !== tab.id && !splitTabIds(layout).includes(t.id));
        return { ...prev, [ck]: rest[rest.length - 1]?.id ?? "" };
      });
      setTimeout(() => window.dispatchEvent(new Event("resize")), 50);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onWorkspaceAdded = (key: string, repo: RepoInfo) => {
    setConfig((c) => (c ? { ...c, repos: { ...c.repos, [key]: repo } } : c));
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
        ids = JSON.parse(localStorage.getItem(`crux.browserTabs.${key}`) ?? "null")?.tabs?.map((t: { id: number }) => t.id) ?? ids;
      } catch {
        /* keep default */
      }
      for (const id of ids) {
        const label = id === 1 ? browserLabel(key) : `${browserLabel(key)}-t${id}`;
        void invoke("browser_close", { label }).catch(() => undefined);
      }
      localStorage.removeItem(`crux.browserTabs.${key}`);
    }
    for (const chat of chatsOf(key)) {
      for (const t of tabs[chat] ?? []) {
        send({ type: "term:kill", id: t.id });
        disposeTerm(t.id);
      }
    }
    setTabs((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => wsOf(k) !== key)));
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
        { label: "Remove from Sidebar", icon: MenuIcons.remove, onSelect: () => setConfirmRemove(key) },
        {
          label: "Delete",
          icon: MenuIcons.trash,
          danger: true,
          shortcut: KEY.deleteWs,
          onSelect: () => {
            setDeleteError("");
            setConfirmDelete(key);
          },
        },
      ],
    ];
  };

  revealBrowserRef.current = (ws: string) => {
    // Browser panel off in Settings: agents use the hidden browser instead.
    if (ws !== viewRef.current || !settings.browser) return;
    if (rightHidden) hideRight(false);
    if (panelTabs[ws] !== "browser") setPanelTab(ws, "browser");
  };

  reportIssueRef.current = async () => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const ws = viewRef.current;
    const jira = ws === "jira";
    if (!jira && (!ws || isSpecial(ws) || !config?.repos[ws])) return setToast("Open a workspace or Jira first");
    if (config?.browserSupported === false) return setToast("Marking issues needs the browser, which is macOS-only for now");
    if (!jira && !settings.browser) return setToast("Turn on the browser panel in Settings to mark issues");
    const { invoke } = await import("@tauri-apps/api/core");
    const label = activeBrowserLabel(SHARED_BROWSER);
    // Pressed again while marking: cancel.
    if (markingRef.current) {
      void invoke("browser_js", { label, script: CANCEL_REPORT_SCRIPT }).catch(() => undefined);
      return;
    }
    if (!jira) {
      if (rightHidden) hideRight(false);
      if (panelTabs[ws] !== "browser") setPanelTab(ws, "browser");
    }
    const chat = ck;
    markingRef.current = true;
    try {
      await new Promise((res) => setTimeout(res, 350)); // let the browser pane show
      const raw = await invoke<string>("browser_js", { label, script: REPORT_SCRIPT, timeoutSecs: 600 });
      const issue = JSON.parse(raw) as MarkedIssue | null;
      if (!issue) return;
      const shot = await cropShot(await invoke<string>("browser_screenshot", { label }), issue);
      const path = await saveShot(shot);
      if (jira) setShotPick({ path, preview: URL.createObjectURL(shot), issue });
      else setIssueBar({ chat: await pasteImage({ chat }, path), path, issue });
    } catch (err) {
      setToast(`Couldn't mark the page: ${String(err)}`);
    } finally {
      markingRef.current = false;
    }
  };

  // The agent the issue goes to: the focused agent in the chat, else any agent
  // in it; null → a new Claude tab is started for it.
  const agentTarget = (chat: string) => {
    const list = tabs[chat] ?? [];
    return (
      list.find((t) => t.agent && t.id === focusedTerm[wsOf(chat)]) ??
      list.find((t) => t.agent && t.id === activeTab[chat]) ??
      list.find((t) => t.agent) ??
      null
    );
  };

  const saveShot = async (shot: Blob, name = "issue.png") => {
    const r = await api(`/api/attachments?name=${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: shot,
    });
    if (!r.ok) throw new Error(`saving the screenshot failed (${r.status})`);
    return ((await r.json()) as { path: string }).path;
  };

  // Screenshot to agent (menu bar crosshair): save it, then pick the chat.
  screenshotRef.current = (png) => {
    const preview = `data:image/png;base64,${png}`;
    void fetch(preview)
      .then((r) => r.blob())
      .then((blob) => saveShot(blob, "screenshot.png"))
      .then((path) => setShotPick({ path, preview }))
      .catch((err) => setToast(`Couldn't save the screenshot: ${String(err)}`));
  };

  // Just the marked screenshot goes into the agent's input (Claude shows it as
  // [Image #1]); nothing is sent, so the user types the question. Target: a
  // chat, or a new Claude chat in a workspace.
  const pasteImage = (to: { chat: string } | { newIn: string }, path: string) => deliverToAgent(to, `${path} `, false);

  // Put text into an agent's input in a chat (starting Claude there if it
  // has none); `submit` presses Enter too.
  const deliverToAgent = async (
    to: { chat: string } | { newIn: string },
    text: string,
    submit: boolean,
    title = "claude",
    kind: "claude" | "codex" = "claude",
  ) => {
    let chat: string;
    let id: string | undefined;
    if ("newIn" in to) {
      chat = newChatKey(to.newIn);
      id = addTab(chat, kind, kind, agentBoot(kind));
      setChatTitles((prev) => ({ ...prev, [chat]: title }));
      setChatsShown(to.newIn, true);
    } else {
      chat = to.chat;
      id = agentTarget(chat)?.id;
    }
    openChat(chat);
    if (!id || "newIn" in to) {
      id ??= addTab(chat, kind, kind, agentBoot(kind));
      // Give the agent time to start before pasting.
      for (let i = 0; i < 20; i++) {
        await new Promise((res) => setTimeout(res, 500));
        try {
          const p = await api(`/api/term/${encodeURIComponent(id)}/process`);
          if (p.ok && new RegExp(kind, "i").test(String((await p.json()).process ?? ""))) break;
        } catch {
          /* keep waiting */
        }
      }
      await new Promise((res) => setTimeout(res, 2500));
    }
    send({ type: "term:input", id, data: `\x1b[200~${text}\x1b[201~` });
    const target = id;
    if (submit) setTimeout(() => send({ type: "term:input", id: target, data: "\r" }), 400);
    setToast(submit ? "Asked the agent" : "Added to the chat");
    setActiveTab((prev) => ({ ...prev, [chat]: id! }));
    setTimeout(() => focusTerm(target), 150);
    return chat;
  };

  const notePipelines = useCallback((info: PipelineInfo | null) => {
    const ws = viewRef.current;
    const tone = overallTone(info);
    setPipeTone((prev) => {
      if (prev[ws] === tone) return prev;
      const { [ws]: _old, ...rest } = prev;
      return tone ? { ...rest, [ws]: tone } : rest;
    });
  }, []);

  // Pipelines "Check errors": the run's details go to the workspace's agent
  // (current chat, else a new Claude chat) and are sent.
  const checkPipeline = (prompt: string) => {
    const ws = viewRef.current;
    const to = ck && wsOf(ck) === ws ? { chat: ck } : { newIn: ws };
    void deliverToAgent(to, prompt, true).catch((err) => setToast(String(err)));
  };

  // ⌘B: the shared browser from anywhere. In a workspace it's the panel's
  // Browser tab (pressed again: hide the panel); elsewhere the Browser view
  // (pressed again there: back to where you were). No browser: the panel.
  const lastView = useRef("");
  // ⌘T / ⌘L: show the browser if it's hidden, then a new tab / the address bar.
  useEffect(() => {
    if (view && !isSpecial(view)) lastWs.current = view;
  }, [view]);
  const newSessionWs = config && (config.repos[view] ? view : config.repos[lastWs.current] ? lastWs.current : Object.keys(config.repos)[0]);
  const reopenClosed = () => {
    const last = closedChats.current.pop();
    if (!last || !config?.repos[last.ws]) return;
    const chat = newChatKey(last.ws);
    // Claude reopens its conversation (its --session-id is resumed); Codex
    // shows its resume picker; shells start fresh.
    for (const t of last.tabs) {
      if (t.role === "worker") continue;
      addTab(chat, t.title, t.agent, t.agent === "codex" ? "codex resume" : t.bootCmd);
    }
    setChatTitles((prev) => ({ ...prev, [chat]: last.title }));
    openChat(chat);
    setChatsShown(last.ws, true);
  };
  sessionKeyRef.current = (op) => {
    const list = sessionTabsRef.current;
    const current = !isSpecial(viewRef.current) ? ck : "";
    const at = list.findIndex((t) => t.chat === current);
    const show = (i: number) => {
      const t = list[(i + list.length) % list.length];
      if (!t) return;
      openChat(t.chat);
      setChatsShown(wsOf(t.chat), true);
    };
    if (op === "close") {
      // No session on screen: ⌘W closes the window, as before.
      if (!current) return browserKeyRef.current("close");
      requestClose({ key: current, id: "", name: chatTitle(current) });
    } else if (op === "reopen") reopenClosed();
    else if (op.startsWith("tab-")) {
      const n = Number(op.slice(4));
      show(n === 9 ? list.length - 1 : n - 1);
    } else if (op.startsWith("next-tab")) show(at + 1);
    else if (op.startsWith("prev-tab")) show(at < 0 ? list.length - 1 : at - 1);
  };
  // Keys follow focus: on a web page (the page has keyboard focus, so this
  // document doesn't), in the Browser view or the browser's own bar they act
  // on browser tabs; anywhere else in Crux, tab keys act on session tabs.
  // The menu and the key fallback can both report one press: once is enough.
  const lastKey = useRef({ op: "", at: 0 });
  routeKeyRef.current = (op) => {
    const now = Date.now();
    if (lastKey.current.op === op && now - lastKey.current.at < 300) return;
    lastKey.current = { op, at: now };
    const inBrowser =
      viewRef.current === "jira" || !document.hasFocus() || !!(document.activeElement as HTMLElement | null)?.closest?.(".browser");
    const sessionOp = op === "close" || op === "reopen" || op.startsWith("tab-") || op.startsWith("next-tab") || op.startsWith("prev-tab");
    if (!inBrowser && sessionOp) sessionKeyRef.current(op);
    else browserKeyRef.current(op);
  };
  browserKeyRef.current = (op) => {
    const v = viewRef.current;
    if (config?.browserSupported === false) return;
    const browserShown = v === "jira" || (!!v && !isSpecial(v) && settings.browser && !rightHidden && (panelTabs[v] ?? "") === "browser");
    // Only ⌘T / ⌘L / ⌘⇧T bring the browser up; the rest act on a browser on screen.
    if (!browserShown && !["new-tab", "url", "reopen"].includes(op)) {
      // ⌘W with no browser showing: close the window, as before.
      if (op === "close") void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().close());
      return;
    }
    if (browserShown) return void window.dispatchEvent(new CustomEvent("ql:browser-key", { detail: op }));
    if (v && !isSpecial(v) && settings.browser) {
      if (rightHidden) hideRight(false);
      if ((panelTabs[v] ?? "") !== "browser") setPanelTab(v, "browser");
    } else if (v !== "jira" && settings.jira) setView("jira");
    // After the browser has mounted.
    setTimeout(() => window.dispatchEvent(new CustomEvent("ql:browser-key", { detail: op })), 120);
  };
  useEffect(() => {
    if (view && view !== "jira") lastView.current = view;
  }, [view]);
  toggleRightRef.current = () => {
    const v = viewRef.current;
    const ws = !!v && !isSpecial(v);
    const hasBrowser = config?.browserSupported !== false;
    if (ws && hasBrowser && settings.browser) {
      const showing = !rightHidden && (panelTabs[v] ?? "") === "browser";
      if (showing) return hideRight(true);
      if (rightHidden) hideRight(false);
      return setPanelTab(v, "browser");
    }
    if (hasBrowser && settings.jira) return setView(v === "jira" ? lastView.current || "home" : "jira");
    if (ws) hideRight(!rightHidden);
  };

  // Browser view tab name: page title (before " - Site"), else the host.
  const jiraTabName = (t: JiraTab) => {
    if (t.title) return t.title.split(/ [-–|] /)[0] || t.title;
    try {
      return new URL(t.url).hostname.replace(/^www\./, "");
    } catch {
      return t.url;
    }
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
      localStorage.setItem("crux.jiraTabsHidden", h ? "0" : "1");
      return !h;
    });

  const refreshBranch = useCallback((key: string) => {
    api(`/api/workspaces/${key}/branch`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setBranches((b) => ({ ...b, [key]: d?.branch ?? null })))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (view && !isSpecial(view)) refreshBranch(view);
  }, [view, refreshBranch]);

  // Terminals currently shown: the main pane's tab + each split pane's tab.
  const visibleTermIds = (): string[] => {
    const layout = layouts[ck] ?? rootLayout();
    const ids: string[] = [];
    const walk = (n: PaneNode) => {
      if (n.kind === "split") return n.children.forEach(walk);
      if (n.id === MAIN) {
        if (activeTab[ck]) ids.push(activeTab[ck]);
      } else ids.push(paneActive(n));
    };
    walk(layout);
    return ids;
  };

  // Git button: is the target tab running an agent or a plain shell?
  const openGitMenu = async (anchor: DOMRect) => {
    // Target the terminal the user last focused, if it's on screen;
    // otherwise the main pane's active tab.
    const onScreen = visibleTermIds();
    const focused = focusedTerm[view];
    const tabId = focused && onScreen.includes(focused) ? focused : activeTab[ck];
    const tab = (tabs[ck] ?? []).find((t) => t.id === tabId);
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
    const panes = onScreen.length > 1;
    setGitMenu({ anchor, mode, tabId: tab.id, target: panes ? tab.title : "" });
  };

  // Type the action into the terminal, then press Enter separately (TUIs
  // like Claude Code treat text+CR in one burst as a paste).
  const runGitAction = (action: GitAction, mode: "agent" | "shell", tabId: string) => {
    const text = mode === "agent" ? action.agent : action.shell;
    send({ type: "term:input", id: tabId, data: text });
    if (mode === "agent" || !action.shellNoEnter) setTimeout(() => send({ type: "term:input", id: tabId, data: "\r" }), 150);
  };

  const setChatsShown = (key: string, shown: boolean) =>
    setChatsOpen((prev) => {
      if (prev.has(key) === shown) return prev;
      const next = new Set(prev);
      if (shown) next.add(key);
      else next.delete(key);
      return next;
    });

  agentEventRef.current = (term, event, detail) => {
    const chat = Object.keys(tabs).find((k) => tabs[k].some((t) => t.id === term));
    if (!chat) return;
    const tab = tabs[chat].find((t) => t.id === term)!;
    // Workers report to their lead (and the team chips), not as the chat.
    if (tab.role === "worker") return;
    // Hooks report Claude; the output guess is only for Codex.
    if (event.startsWith("codex") !== (tab.agent === "codex")) return;
    if (detail) setChatDetail((d) => (d.get(chat) === detail ? d : new Map(d).set(chat, detail)));
    if (event === "working" || event === "codex-working") {
      workingTab.current.set(chat, term);
      setWorking((w) => (w.has(chat) ? w : new Map(w).set(chat, Date.now())));
      // Working again: an older "finished" dot no longer applies.
      setAttention((a) => {
        if (!a.has(chat)) return a;
        const next = new Map(a);
        next.delete(chat);
        return next;
      });
      return;
    }
    setWorking((w) => {
      if (!w.has(chat)) return w;
      const next = new Map(w);
      next.delete(chat);
      return next;
    });
    const ws = wsOf(chat);
    const watching = document.hasFocus() && viewRef.current === ws && (activeChat[ws] ?? chatsOf(ws)[0]) === chat;
    if (watching) return;
    const kind = event === "input" ? "input" : "stop";
    setAttention((a) => (a.get(chat) === kind ? a : new Map(a).set(chat, kind)));
    if (!settings.notifyAgent) return;
    const where = config?.repos[ws]?.label ?? ws;
    const title = `${chatTitle(chat)} · ${where}`;
    sentNotes.current.set(chat, (sentNotes.current.get(chat) ?? new Set()).add(title));
    void notify(title, detail || (event === "input" ? "Needs your input" : "Finished"));
  };
  // Looking at a chat (window focused) clears its "needs you" dot and takes
  // its notification banners down.
  const shownChat = view ? (activeChat[view] && tabs[activeChat[view]] ? activeChat[view] : chatsOf(view)[0]) : undefined;
  useEffect(() => {
    if (!shownChat || view === "home" || !windowFocused) return;
    setAttention((a) => {
      if (!a.has(shownChat)) return a;
      const next = new Map(a);
      next.delete(shownChat);
      return next;
    });
    const titles = sentNotes.current.get(shownChat);
    if (titles?.size) {
      sentNotes.current.delete(shownChat);
      void invokeTauri("clear_notifications", { titles: [...titles] });
    }
  }, [shownChat, view, windowFocused]);

  // Desktop app: keep running in the menu bar / ⌥Space, and the menu bar count.
  useEffect(() => {
    if (config) void invokeTauri("set_background", { keepRunning: settings.keepRunning, quickAsk: settings.quickAsk });
  }, [settings.keepRunning, settings.quickAsk, !!config]); // eslint-disable-line react-hooks/exhaustive-deps
  // Menu bar: "⟳ 2" agents working, "● 1" waiting for you.
  const workingCount = [...working.keys()].filter((c) => tabs[c]).length;
  useEffect(() => {
    const parts = [workingCount && `⟳ ${workingCount}`, attention.size && `● ${attention.size}`].filter(Boolean);
    void invokeTauri("set_tray_title", { title: parts.join("  ") });
  }, [workingCount, attention.size]);
  // Menu bar panel: open agent chats, like Home's card. Needs input first,
  // then finished, working (longest running on top), idle.
  const rank = (chat: string) => {
    const a = attention.get(chat);
    return a === "input" ? 0 : a === "stop" ? 1 : working.has(chat) ? 2 : 3;
  };
  const trayChats: TrayAgent[] = config
    ? Object.keys(tabs)
        .filter((chat) => config.repos[wsOf(chat)] && tabs[chat].some((t) => t.agent))
        .sort((a, b) => rank(a) - rank(b) || (working.get(a) ?? 0) - (working.get(b) ?? 0))
        .map((chat) => ({
          chat,
          name: chatTitle(chat),
          wsLabel: config.repos[wsOf(chat)].label,
          kinds: [...new Set(tabs[chat].map((t) => t.agent ?? "shell"))],
          workingSince: working.get(chat),
          waiting: attention.get(chat),
          detail: chatDetail.get(chat),
          team: teams.get(chat)?.workers,
        }))
    : [];
  const trayKey = JSON.stringify(trayChats);
  useEffect(() => {
    void invokeTauri("set_tray_chats", { chats: JSON.parse(trayKey) });
  }, [trayKey]);
  // Working, but the agent's own tab has been quiet for 20 s: it stopped
  // (interrupted with Esc sends no "finished"), or the tab closed. Only that
  // tab counts: a dev server or test watcher next to it prints all the time,
  // while a working agent redraws its spinner and timer constantly.
  useEffect(() => {
    if (!working.size) return;
    const t = setInterval(() => {
      setWorking((w) => {
        let changed = false;
        const next = new Map(w);
        for (const chat of w.keys()) {
          const all = (tabsRef.current[chat] ?? []).map((t) => t.id);
          const agentTab = workingTab.current.get(chat);
          const ids = agentTab && all.includes(agentTab) ? [agentTab] : agentTab ? [] : all;
          const last = Math.max(0, ...ids.map((id) => lastOutput.current.get(id) ?? 0));
          if (!ids.length || Date.now() - Math.max(last, w.get(chat)!) > 20_000) {
            next.delete(chat);
            changed = true;
          }
        }
        return changed ? next : w;
      });
    }, 10_000);
    return () => clearInterval(t);
  }, [working.size]);

  // ⌥Space quick ask: a new Claude chat named after the prompt's first words.
  quickAskRef.current = ({ ws, text, agent }) => {
    const target = config?.repos[ws] ? ws : Object.keys(config?.repos ?? {})[0];
    if (!target || !text.trim()) return;
    const title = text.trim().split(/\s+/).slice(0, 4).join(" ").slice(0, 32);
    void deliverToAgent({ newIn: target }, text.trim(), true, title, agent === "codex" ? "codex" : "claude").catch((err) => setToast(String(err)));
  };

  // Setup → "Log in" / "Install": run the fix in a new terminal chat.
  const runInTerminal = (cmd: string, tool: string) => {
    const ws = config?.repos[view] ? view : Object.keys(config?.repos ?? {})[0];
    if (!ws) {
      void navigator.clipboard.writeText(cmd).catch(() => undefined);
      return setToast("Copied. Paste it in Terminal");
    }
    const chat = newChatKey(ws);
    addTab(chat, tool, undefined, cmd);
    setChatTitles((prev) => ({ ...prev, [chat]: `${tool} setup` }));
    setSettingsOpen(false);
    openChat(chat);
    setChatsShown(ws, true);
  };

  // ⌘K → a past conversation: reopen it in its own chat (or show it if it's open).
  const resumePast = (ws: string, past: PastChat) => {
    setSearchOpen(false);
    const open = Object.keys(tabs).find((k) => tabs[k].some((t) => t.bootCmd?.includes(past.id)));
    if (open) return openChat(open);
    const chat = newChatKey(ws);
    const cmd = past.kind === "claude" ? `claude --resume ${past.id}` : `codex resume ${past.id}`;
    const title = past.title.slice(0, 40) || past.kind;
    addTab(chat, past.kind, past.kind, cmd);
    setChatTitles((prev) => ({ ...prev, [chat]: title }));
    openChat(chat);
    setChatsShown(ws, true);
  };

  // Show a chat (its whole layout) from the sidebar.
  const openChat = (chat: string) => {
    const ws = wsOf(chat);
    setView(ws);
    setActiveChat((prev) => ({ ...prev, [ws]: chat }));
  };
  openChatRef.current = (chat) => {
    if (!tabs[chat]) return;
    openChat(chat);
    setChatsShown(wsOf(chat), true);
  };

  // A new chat is a new screen in the workspace with one terminal / agent.
  const newChat = (key: string, kind: "claude" | "codex" | "shell", name: string) => {
    const chat = newChatKey(key);
    const title = name.trim() || (kind === "shell" ? "shell" : kind);
    if (kind === "shell") addTab(chat, title);
    else addTab(chat, title, kind, agentBoot(kind));
    setChatTitles((prev) => ({ ...prev, [chat]: title }));
    setActiveChat((prev) => ({ ...prev, [key]: chat }));
    setView(key);
    setChatsShown(key, true);
  };

  // Orchestrator mode: a new chat whose Claude leads a team. The server learns
  // about the lead before its terminal opens (same socket, sent first).
  const startOrchestrator = (key: string, opts: OrchestrateOpts) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return setToast("Not connected to the Crux server");
    const chat = newChatKey(key);
    const title = opts.task.split(/\s+/).slice(0, 4).join(" ").slice(0, 32) || "orchestrator";
    // The lead follows the workers: Codex for a Codex team, else Claude.
    const lead = opts.kind === "codex" ? "codex" : "claude";
    const id = addTab(chat, title, lead, agentBoot(lead));
    setTabs((prev) => ({ ...prev, [chat]: (prev[chat] ?? []).map((t) => (t.id === id ? { ...t, role: "lead" } : t)) }));
    send({ type: "orch:start", ws: key, chat, lead: id, max: opts.max, kind: opts.kind, model: opts.model, codexModel: opts.codexModel, approve: opts.approve, task: opts.task });
    setChatTitles((prev) => ({ ...prev, [chat]: title }));
    setActiveChat((prev) => ({ ...prev, [key]: chat }));
    setView(key);
    setChatsShown(key, true);
  };

  // Server → orchestrator events: a worker started (a pane next to the lead,
  // stacked on the right), closed, or the team's status changed.
  orchRef.current = (msg) => {
    if (msg.type === "orch:team") {
      setTeams((prev) => {
        const next = new Map(prev);
        for (const [c, t] of prev) if (t.lead === msg.lead) next.delete(c);
        if (msg.chat) next.set(String(msg.chat), { lead: String(msg.lead), workers: Array.isArray(msg.workers) ? msg.workers : [] });
        return next;
      });
    } else if (msg.type === "orch:spawn") {
      const chat = String(msg.chat);
      const id = String(msg.id);
      if (!tabs[chat] || tabs[chat].some((t) => t.id === id)) return;
      createTab(chat, String(msg.name), String(msg.kind), String(msg.bootCmd), id, "worker");
      setLayouts((prev) => {
        const root = prev[chat] ?? rootLayout();
        const panes = leafIds(root).filter((p) => p !== MAIN);
        const last = panes[panes.length - 1];
        const next = !last ? insertAt(root, MAIN, "right", id) : panes.length + 1 < MAX_PANES ? insertAt(root, last, "bottom", id) : addTabToPane(root, last, id);
        return { ...prev, [chat]: next };
      });
    } else if (msg.type === "orch:close") {
      const chat = String(msg.chat);
      if (tabs[chat]?.some((t) => t.id === msg.id)) closeTab(chat, String(msg.id));
    }
  };

  // Close a whole chat: every terminal in it.
  const closeChat = (chat: string) => {
    if (tabs[chat]?.length) {
      closedChats.current = [...closedChats.current.slice(-19), { ws: wsOf(chat), title: chatTitle(chat), tabs: tabs[chat] }];
    }
    for (const t of tabs[chat] ?? []) {
      send({ type: "term:kill", id: t.id });
      disposeTerm(t.id);
    }
    const ws = wsOf(chat);
    const siblings = chatsOf(ws).filter((k) => k !== chat);
    setLayouts(({ [chat]: _l, ...rest }) => rest);
    setChatTitles(({ [chat]: _t, ...rest }) => rest);
    setTabs(({ [chat]: _gone, ...rest }) => rest);
    setActiveChat((a) => {
      if (a[ws] !== chat) return a;
      if (siblings.length) return { ...a, [ws]: siblings[siblings.length - 1] };
      const { [ws]: _gone, ...rest } = a;
      return rest;
    });
  };

  const afterIntro = useCallback(() => setOnboarding("name"), []);
  const saveName = (name: string) => {
    setConfig((c) => (c ? { ...c, userName: name } : c));
    setOnboarding("mode");
    void api("/api/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
  };
  const finishOnboarding = () => {
    setOnboarding(null);
    void api("/api/onboarded", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ done: true }),
    });
  };

  const renameChat = (chat: string, title: string) => {
    setRenamingChat(null);
    const next = title.trim();
    if (next) setChatTitles((prev) => ({ ...prev, [chat]: next }));
  };

  // Suggested name: "claude", "claude 2", … whichever is free.
  const askChatName = (key: string, kind: "claude" | "codex" | "shell") => {
    const taken = new Set(chatsOf(key).map(chatTitle));
    let name: string = kind;
    for (let n = 2; taken.has(name); n++) name = `${kind} ${n}`;
    if (settings.askChatName) setNameChat({ key, kind, name });
    else newChat(key, kind, name);
  };


  const hideRight = (hidden: boolean) => {
    setRightHidden(hidden);
    localStorage.setItem("crux.rightHidden", hidden ? "1" : "0");
  };

  // Enter confirms / Esc cancels in every dialog.
  useModalKeys(!!confirmClose, {
    onEnter: () => {
      if (!confirmClose) return;
      doClose(confirmClose);
      setConfirmClose(null);
    },
    onEscape: () => setConfirmClose(null),
  });
  useModalKeys(!!confirmDelete, {
    onEnter: () => confirmDelete && void trashWs(confirmDelete),
    onEscape: () => setConfirmDelete(null),
  });
  useModalKeys(!!confirmRemove, {
    onEnter: () => confirmRemove && void removeWs(confirmRemove),
    onEscape: () => setConfirmRemove(null),
  });
  useModalKeys(!!nameChat, {
    onEnter: () => {
      if (!nameChat) return;
      newChat(nameChat.key, nameChat.kind, nameChat.name);
      setNameChat(null);
    },
    onEscape: () => setNameChat(null),
  });

  if (!config) return <div className="loading">Loading Crux…</div>;

  // Session tab bar: open chats of every workspace (or this one's).
  const sessionTabs: SessionTab[] = orderedChats
    .filter((chat) => config.repos[wsOf(chat)] && (settings.tabsAll !== false || wsOf(chat) === view))
    .map((chat) => {
      const r = config.repos[wsOf(chat)];
      const a = attention.get(chat);
      return {
        chat,
        name: chatTitle(chat),
        wsLabel: r.label,
        badge: avatarStyle(r),
        kind: tabs[chat].find((t) => t.agent && t.role !== "worker")?.agent ?? "shell",
        status: working.has(chat) ? "working" : a === "input" ? "input" : a === "stop" ? "done" : undefined,
        detail: chatDetail.get(chat),
        group: wsOf(chat),
        tint: r.color,
      };
    });
  {
    // Same grouping as the bar shows (⌘1–9 follow what you see).
    const groups = [...new Set(sessionTabs.map((t) => t.group))];
    sessionTabs.splice(0, sessionTabs.length, ...groups.flatMap((g) => sessionTabs.filter((t) => t.group === g)));
  }
  sessionTabsRef.current = sessionTabs;

  // ⌘K: everything you can jump to or do, besides past conversations.
  const paletteItems = (): PaletteItem[] => {
    const repos = Object.entries(config.repos);
    const here = newSessionWs ?? "";
    const state = { working: "working", input: "needs you", done: "finished" };
    const items: PaletteItem[] = sessionTabs.map((t) => ({
      key: `s:${t.chat}`,
      section: "Sessions",
      icon: t.kind === "claude" ? <ClaudeLogo /> : t.kind === "codex" ? <CodexLogo /> : <TerminalIcon />,
      title: t.name,
      sub: [t.wsLabel, t.detail].filter(Boolean).join(" · "),
      hint: t.status ? state[t.status] : "open",
      keywords: t.kind,
      run: () => {
        openChat(t.chat);
        setChatsShown(wsOf(t.chat), true);
      },
    }));
    if (settings.jira && config.browserSupported !== false) {
      for (const t of jiraTabs.tabs) {
        items.push({ key: `b:${t.id}`, section: "Browser tabs", icon: <GlobeIcon />, title: jiraTabName(t), sub: t.url, keywords: "browser tab", run: () => openJiraTab(t.id) });
      }
    }
    const go = (key: string, title: string, icon: React.ReactNode, run: () => void, keywords = "", hint?: string) =>
      items.push({ key: `g:${key}`, section: "Go to", icon, title, run, keywords, hint });
    go("home", "Home", <WebIcon />, () => setView("home"), "start dashboard");
    if (settings.sessionsView !== false) go("sessions", "Sessions", <TerminalIcon />, () => setView("sessions"), "past history");
    if (settings.jira && config.browserSupported !== false) go("browser", "Browser", <GlobeIcon />, () => setView("jira"), "web", KEY.panel);
    if (showConnections) go("connections", "Connections", <WebIcon />, () => setView("connections"), "features graph coverage");
    for (const [key, r] of repos) go(`ws:${key}`, r.label, <span className="avatar search-avatar" style={avatarStyle(r)}>{r.label[0]?.toUpperCase()}</span>, () => setView(key), `workspace ${r.path}`);
    for (const [page, label] of SETTINGS_PAGES) {
      go(`set:${page}`, `Settings: ${label}`, MenuIcons.rename, () => {
        setSettingsPage(page);
        setSettingsOpen(true);
      }, "settings preferences");
    }
    // Actions: new sessions in the workspace on screen first, then in any workspace.
    const act = (key: string, title: string, icon: React.ReactNode, run: () => void, keywords = "", hint?: string) =>
      items.push({ key: `a:${key}`, section: "Actions", icon, title, run, keywords, hint });
    const ordered = [...repos].sort(([a], [b]) => Number(b === here) - Number(a === here));
    for (const [key, r] of ordered) {
      act(`claude:${key}`, `New Claude chat in ${r.label}`, <ClaudeLogo />, () => askChatName(key, "claude"), "new start");
      act(`codex:${key}`, `New Codex chat in ${r.label}`, <CodexLogo />, () => askChatName(key, "codex"), "new start");
      act(`shell:${key}`, `New terminal in ${r.label}`, <TerminalIcon />, () => askChatName(key, "shell"), "new shell");
      act(`orch:${key}`, `Orchestrate in ${r.label}`, <OrchestrateIcon />, () => setOrchestrate(key), "team agents split");
    }
    if (closedChats.current.length) act("reopen", "Reopen closed session", MenuIcons.read, reopenClosed, "undo", "⌘⇧T");
    act("add-ws", "Add workspace…", MenuIcons.folder, () => setAdding(true), "folder repo new");
    act("updates", "Check for updates", MenuIcons.read, () => {
      setSettingsPage("updates");
      setSettingsOpen(true);
    }, "version");
    act("sidebar", sideHidden ? "Show sidebar" : "Hide sidebar", MenuIcons.read, toggleSide, "toggle", KEY.sidebar);
    return items;
  };

  const chatRow = (chat: string) => ({
    chat,
    ws: wsOf(chat),
    wsLabel: config.repos[wsOf(chat)]?.label ?? wsOf(chat),
    name: chatTitle(chat),
    kinds: [...new Set((tabs[chat] ?? []).map((t) => t.agent ?? "shell"))],
  });

  const isSpecialView = isSpecial(view);
  const repo = !isSpecialView ? config.repos[view] : undefined;
  const isTestRepo = repo && (repo.kind === "playwright" || repo.kind === "pytest");
  // Right panel tabs, as allowed by Settings (QA panels, browser).
  // Each tab can be hidden in Settings → Tabs & views.
  const panelTabList: [string, string][] = repo
    ? ([
        repo.kind === "mkdocs" && settings.docPreview && ["preview", "Doc preview"],
        isTestRepo && settings.tests && ["tree", "Tests"],
        isTestRepo && settings.coverage && ["coverage", "Coverage"],
        isTestRepo && settings.pipelines && ["pipelines", "Pipelines"],
        settings.browser && ["browser", "Browser"],
      ].filter(Boolean) as [string, string][])
    : [];
  // Nothing to show on the right → chats take the full width.
  const hasPanel = panelTabList.length > 0;
  const panelHidden = rightHidden || !hasPanel;
  const panelTab = panelTabList.some(([k]) => k === panelTabs[view]) ? panelTabs[view] : panelTabList[0]?.[0];
  // Native browser views float above HTML: hide them under overlays.
  const overlayOpen = adding || !!menu || !!confirmDelete || !!agentDrag || dragging || !!gitMenu || !!chatMenu || !!nameChat || !!confirmClose || !!onboarding || !!chatCtx || settingsOpen || !!shotPick || searchOpen;
  const viewLayout = (!isSpecialView && layouts[ck]) || rootLayout();
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
      setLayouts((prev) => ({ ...prev, [ck]: setSizesAt(prev[ck] ?? rootLayout(), path, next) }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.dispatchEvent(new Event("resize"));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const hasSplits = viewLayout.kind === "split";
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
      const t = (tabs[ck] ?? []).find((x) => x.id === activeTab[ck] && !viewSplits.includes(x.id));
      return (
        <div className={`term-slot ${hasSplits && t && focusedTerm[view] === t.id ? "focused" : ""}`} data-pane-id={MAIN} key={MAIN}>
          {t && <Term key={t.id} id={t.id} repo={view} bootCmd={t.bootCmd} connected={connected} send={send} subscribe={subscribe} onFocus={noteFocus} />}
        </div>
      );
    }
    // A split pane with its own tabs.
    const ids = paneTabs(node);
    const activeId = paneActive(node);
    const paneTabList = ids.map((id) => (tabs[ck] ?? []).find((x) => x.id === id)).filter(Boolean) as TermTab[];
    const shown = paneTabList.find((x) => x.id === activeId) ?? paneTabList[paneTabList.length - 1];
    if (!shown) return null;
    return (
      <div className={`term-slot split ${focusedTerm[view] === shown.id ? "focused" : ""}`} data-pane-id={node.id} key={node.id}>
        <div className="term-slot-head">
          <div className="pane-tabs">
            {paneTabList.map((t) => (
              <span
                key={t.id}
                className={`pane-tab ${t.id === shown.id ? "on" : ""}`}
                onPointerDown={startTabDrag(t)}
                onClick={() => setLayouts((prev) => ({ ...prev, [ck]: setPaneActive(prev[ck] ?? rootLayout(), node.id, t.id) }))}
              >
                {t.agent === "claude" && <ClaudeLogo />}
                {t.agent === "codex" && <CodexLogo />}
                <span className="pane-tab-title">{t.title}</span>
                <button
                  className="term-tab-close"
                  title="Close this terminal"
                  onClick={(e) => {
                    e.stopPropagation();
                    requestClose({ key: ck, id: t.id, name: t.title });
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
              const id = createTab(ck);
              setLayouts((prev) => ({ ...prev, [ck]: addTabToPane(prev[ck] ?? rootLayout(), node.id, id) }));
            }}
          >
            +
          </button>
        </div>
        <Term key={shown.id} id={shown.id} repo={view} bootCmd={shown.bootCmd} connected={connected} send={send} subscribe={subscribe} onFocus={noteFocus} />
      </div>
    );
  };

  return (
    <div className="app">
      {/* data-tauri-drag-region: the top bar moves the window (no title bar). */}
      <header className="topbar" data-tauri-drag-region>
        <span className="brand" data-tauri-drag-region>
          <img src="/crux-mark.svg" alt="" className="brand-mark" />
          <span className="brand-name">Crux</span>
          {import.meta.env.DEV && <span className="brand-dev" title="Development build (npm run app:dev)">DEV</span>}
        </span>
        <button className="side-toggle" title={sideHidden ? `Show sidebar (${KEY.sidebar})` : `Hide sidebar (${KEY.sidebar})`} onClick={toggleSide}>
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
            <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
            <path d="M6 2.5v11" />
          </svg>
        </button>
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
          <button
            className="agent-btn"
            disabled={!repo}
            title={repo ? `Click for a new terminal · drag into the terminal for a tab or split` : "Pick a workspace first"}
            onPointerDown={repo ? startAgentDrag("shell") : undefined}
          >
            <TerminalIcon /> Terminal
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
          <button className="side-search" onClick={() => setSearchOpen(true)} title="Search open chats and past conversations">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <circle cx="7" cy="7" r="4.5" />
              <path d="m10.5 10.5 3 3" />
            </svg>
            Search chats
            <kbd>{KEY.search}</kbd>
          </button>
          <button className={`side-item view-item side-home ${view === "home" ? "active" : ""}`} onClick={() => setView("home")} title="Home: what needs you">
            <span className="avatar view-icon">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
                <path d="M2.5 7.2 8 2.5l5.5 4.7V13a.5.5 0 0 1-.5.5H9.8V10H6.2v3.5H3a.5.5 0 0 1-.5-.5z" />
              </svg>
            </span>
            <span className="side-label">Home</span>
            {attention.size > 0 && <span className="home-count">{attention.size}</span>}
          </button>
          {/* Views, right under Home (each can be hidden in Settings → Tabs & views). */}
          {settings.sessionsView !== false && (
          <button
            className={`side-item view-item ${view === "sessions" ? "active" : ""}`}
            onClick={() => setView("sessions")}
          >
            <span className="avatar view-icon"><TerminalIcon /></span>
            <span className="side-label">Sessions</span>
          </button>
          )}
          {showConnections && (
          <button
            className={`side-item view-item ${view === "connections" ? "active" : ""}`}
            onClick={() => setView("connections")}
          >
            <span className="avatar view-icon"><WebIcon /></span>
            <span className="side-label">Connections</span>
          </button>
          )}
          {settings.jira && (
          <>
          <button
            className={`side-item view-item ${view === "jira" ? "active" : ""}`}
            onClick={() => setView("jira")}
          >
            <span className="avatar view-icon"><GlobeIcon /></span>
            <span className="side-label">Browser</span>
            {jiraTabs.tabs.length > 0 && (
              <span
                className={`side-sub-toggle ${jiraTabsHidden ? "collapsed" : ""}`}
                role="button"
                title={jiraTabsHidden ? "Show open tabs" : "Hide open tabs"}
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
          </>
          )}
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
              <Fragment key={key}>
              <div
                className={`side-item ${view === key ? "active" : ""}`}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ key, x: e.clientX, y: e.clientY });
                }}
              >
                <button
                  className="side-item-main"
                  onClick={() => {
                    // The whole row up to + opens the workspace and folds /
                    // unfolds its chats.
                    setChatsShown(key, !chatsOpen.has(key));
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
                  {chatsOf(key).some((c) => working.has(c)) && <span className="agent-spin side-spin" title="An agent is working" />}
                </button>
                {chatsOf(key).length > 0 && (
                  <span
                    className={`side-sub-toggle ws-chat-toggle ${chatsOpen.has(key) ? "" : "collapsed"}`}
                    role="button"
                    title={chatsOpen.has(key) ? "Hide chats" : "Show chats"}
                    onClick={() => {
                      setChatsShown(key, !chatsOpen.has(key));
                      setView(key);
                    }}
                  >
                    <small>{chatsOf(key).length}</small>
                    <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M2.5 3.75 5 6.25l2.5-2.5" />
                    </svg>
                  </span>
                )}
                <button
                  className="side-remove side-add-chat"
                  title="New chat"
                  onClick={(e) => {
                    if (settings.defaultChat !== "pick") return askChatName(key, settings.defaultChat);
                    const r = e.currentTarget.getBoundingClientRect();
                    setChatMenu({ key, x: r.right + 6, y: r.top });
                  }}
                >
                  +
                </button>
                <button className="side-remove" title="Remove workspace (files stay on disk)" onClick={() => setConfirmRemove(key)}>
                  ×
                </button>
              </div>
              <div className={`side-sub ws-chats ${!chatsOpen.has(key) || !chatsOf(key).length ? "collapsed" : ""}`}>
                <div className="side-sub-inner">
                  {(() => {
                    const shown = activeChat[key] && tabs[activeChat[key]] ? activeChat[key] : chatsOf(key)[0];
                    return chatsOf(key).map((chat) => {
                      const name = chatTitle(chat);
                      // One icon per kind of agent in the chat (Claude + Codex split → both).
                      const kinds = [...new Set((tabs[chat] ?? []).map((t) => t.agent ?? "shell"))];
                      return (
                      <div
                        key={chat}
                        className={`side-sub-item ws-chat ${view === key && shown === chat ? "active" : ""}`}
                        onClick={() => openChat(chat)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setChatCtx({ key: chat, id: "", name, x: e.clientX, y: e.clientY });
                        }}
                        title={`${name} · ${(tabs[chat] ?? []).length} terminal${(tabs[chat] ?? []).length === 1 ? "" : "s"}`}
                      >
                        <span className="ws-chat-icons">
                          {kinds.slice(0, 3).map((k) => (
                            <span key={k} className="ws-chat-icon">
                              {k === "claude" ? <ClaudeLogo /> : k === "codex" ? <CodexLogo /> : <TerminalIcon />}
                            </span>
                          ))}
                        </span>
                        {renamingChat === chat ? (
                          <input
                            className="side-rename ws-chat-rename"
                            defaultValue={name}
                            autoFocus
                            onClick={(e) => e.stopPropagation()}
                            onFocus={(e) => e.currentTarget.select()}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") e.currentTarget.blur();
                              if (e.key === "Escape") {
                                e.currentTarget.value = name;
                                e.currentTarget.blur();
                              }
                            }}
                            onBlur={(e) => renameChat(chat, e.currentTarget.value)}
                          />
                        ) : (
                          <span className="side-sub-label">{name}</span>
                        )}
                        {working.has(chat) ? (
                          <span className="agent-spin chat-spin" title="Working" />
                        ) : attention.has(chat) ? (
                          <span
                            className={`chat-attn ${attention.get(chat) === "input" ? "input" : "done"}`}
                            title={attention.get(chat) === "input" ? "Needs your input" : "Finished"}
                          />
                        ) : null}
                        <button
                          className="side-remove"
                          title="Close chat"
                          onClick={(e) => {
                            e.stopPropagation();
                            requestClose({ key: chat, id: "", name });
                          }}
                        >
                          ×
                        </button>
                      </div>
                      );
                    });
                  })()}
                </div>
              </div>
              </Fragment>
            ),
          )}
          {Object.keys(config.repos).length === 0 && (
            <button className="side-item side-empty" onClick={() => setAdding(true)}>
              <span className="avatar">+</span>
              <span className="side-label">Add a repo folder</span>
            </button>
          )}
          {update && (
            <button
              className={`update-bubble ${update.installing ? "busy" : ""}`}
              disabled={update.installing}
              title={update.installing ? "Downloading the update. Crux restarts by itself." : `New Crux version available: install ${update.latest.replace(/^v/, "")} and restart`}
              onClick={installUpdate}
            >
              {update.installing ? <span className="update-spin" /> : <span className="update-dot" />}
              {update.installing ? "Updating…" : `Update to ${update.latest.replace(/^v/, "")}`}
            </button>
          )}
          <div className="side-footer">
            <span className="avatar">{(config.userName || config.user || "?")[0].toUpperCase()}</span>
            {/* A long name shortens with "…"; the version and the gear always fit. */}
            <span className="side-footer-name" title={`${config.userName || config.user} · Crux ${appVersion}`}>
              {config.userName || config.user}
            </span>
            <span className="side-footer-version">· {appVersion}</span>
            <button
              className="settings-btn"
              title={setupCount ? `Settings · ${setupCount} setup problem${setupCount === 1 ? "" : "s"}` : "Settings"}
              onClick={() => setSettingsOpen(true)}
            >
              {setupCount > 0 && <span className="gear-dot" />}
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6.8 1.8h2.4l.4 1.7 1.3.7 1.6-.6 1.2 2.1-1.3 1.1v1.4l1.3 1.1-1.2 2.1-1.6-.6-1.3.7-.4 1.7H6.8l-.4-1.7-1.3-.7-1.6.6-1.2-2.1 1.3-1.1V7.3L2.3 6.2l1.2-2.1 1.6.6 1.3-.7z" />
                <circle cx="8" cy="8" r="2" />
              </svg>
            </button>
          </div>
        </nav>
        <div className="main-col">
        {sessionTabs.length > 0 && (
          <SessionBar
            tabs={sessionTabs}
            active={isSpecialView ? "" : ck}
            showBadges={settings.tabsAll !== false}
            onOpen={(chat) => {
              openChat(chat);
              setChatsShown(wsOf(chat), true);
            }}
            onClose={(chat) => requestClose({ key: chat, id: "", name: chatTitle(chat) })}
            onRename={renameChat}
            onMove={(from, to) =>
              setChatOrder(() => {
                const next = orderedChats.filter((k) => k !== from);
                next.splice(next.indexOf(to) + (orderedChats.indexOf(from) < orderedChats.indexOf(to) ? 1 : 0), 0, from);
                return next;
              })
            }
            onAdd={(e) => setSessionMenu({ x: e.clientX, y: e.clientY + 8 })}
          />
        )}
        {!repo && !isSpecialView ? (
          <section className="full-pane empty-state">
            {settings.mode === "qa" ? (
              <>
                <h2>Add your QA repos</h2>
                <p>
                  Point Crux at the folders you already have: product docs, Playwright E2E, pytest API, the dashboard
                  and backend repos. Each folder's type is detected and gets the right panel: docs preview, test tree and
                  coverage, or just terminals and a browser.
                </p>
              </>
            ) : (
              <>
                <h2>Add a folder</h2>
                <p>Pick any folder you want Claude, Codex or a terminal to work in. It stays where it is; nothing is copied.</p>
              </>
            )}
            <button className="primary" onClick={() => setAdding(true)}>
              + Add workspace
            </button>
            <ol className="empty-steps">
              <li>Add each repo folder with <b>+</b> (they stay where they are; nothing is copied)</li>
              {settings.connections && <li>Add the dashboard and backend repos too to unlock <b>Connections</b></li>}
              <li>Open a terminal, click <b>Claude</b> or <b>Codex</b>, and work</li>
            </ol>
            <SetupChecklist />
          </section>
        ) : view === "home" ? (
          <Home
            userName={config.userName ?? ""}
            needs={[...attention]
              .filter(([chat]) => tabs[chat]?.length && config.repos[wsOf(chat)])
              .map(([chat, event]) => ({ ...chatRow(chat), event }))}
            agents={Object.keys(tabs)
              .filter((chat) => config.repos[wsOf(chat)] && tabs[chat].some((t) => t.agent))
              .map((chat) => ({ ...chatRow(chat), workingSince: working.get(chat), waiting: attention.get(chat), team: teams.get(chat)?.workers }))
              // Working first (longest running on top), then waiting, then idle.
              .sort((a, b) => (a.workingSince ?? Infinity) - (b.workingSince ?? Infinity) || Number(!!b.waiting) - Number(!!a.waiting))}
            pipelines={Object.entries(pipeInfo)
              .filter(([ws]) => config.repos[ws])
              .map(([ws, info]) => ({ ws, wsLabel: config.repos[ws].label, info }))}
            workspaces={searchWorkspaces}
            onOpenChat={(chat) => {
              openChat(chat);
              setChatsShown(wsOf(chat), true);
            }}
            onReview={(mr: InboxMr) => {
              const ws = mr.ws ?? Object.keys(config.repos)[0];
              void deliverToAgent({ newIn: ws }, reviewPrompt(mr), true, `review !${mr.iid}`).catch((err) => setToast(String(err)));
            }}
            onAskPipeline={(ws, prompt) => void deliverToAgent({ newIn: ws }, prompt, true, "pipeline").catch((err) => setToast(String(err)))}
            onResume={resumePast}
            onOpenUrl={(url) => {
              if (!settings.jira) {
                // No in-app browser on Linux / Windows: open it outside Crux.
                if (IN_TAURI && config.browserSupported !== false) return setToast("Turn on the Browser view in Settings → Tabs & views");
                return void window.open(url, "_blank", "noopener");
              }
              setBrowserOpen({ url, nonce: Date.now() });
              setView("jira");
            }}
          />
        ) : view === "sessions" ? (
          <SessionsPanel
            workspaces={Object.fromEntries(Object.entries(config.repos).map(([k, r]) => [k, { label: r.label, badge: avatarStyle(r) }]))}
            isOpen={(id) => Object.values(tabs).some((ts) => ts.some((t) => t.bootCmd?.includes(id)))}
            onResume={resumePast}
          />
        ) : view === "connections" ? (
          <section className="full-pane">
            <FeatureMap onAddWorkspace={() => setAdding(true)} showCoverage={settings.connCoverage} showGraph={settings.connGraph} />
          </section>
        ) : view === "jira" ? (
          // Browser view (internally still "jira", so saved tabs and logins carry over).
          <section className="full-pane jira-pane">
            <Browser wsKey="jira" visible={!overlayOpen} network={settings.network} picker={settings.picker} openRequest={browserOpen} />
          </section>
        ) : (
          <div
            className={`panes ${dragging ? "dragging" : ""}`}
            ref={panesRef}
            style={{ gridTemplateColumns: panelHidden ? "1fr 0px 0fr" : `${split}fr 1px ${100 - split}fr` }}
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
                {(tabs[ck] ?? [])
                  .filter((t) => !viewSplits.includes(t.id))
                  .map((t) => (
                    <span
                      key={t.id}
                      className={`term-tab ${activeTab[ck] === t.id ? "active" : ""}`}
                      title="Drag onto a pane to split"
                      onPointerDown={startTabDrag(t)}
                      onClick={() => setActiveTab((prev) => ({ ...prev, [ck]: t.id }))}
                    >
                      {t.agent === "claude" && <ClaudeLogo />}
                      {t.agent === "codex" && <CodexLogo />}
                      {t.title}
                      {(
                        <button
                          className="term-tab-close"
                          title="Close terminal"
                          onClick={(e) => {
                            e.stopPropagation();
                            requestClose({ key: ck, id: t.id, name: t.title });
                          }}
                        >
                          ×
                        </button>
                      )}
                    </span>
                  ))}
                <button className="term-tab-add" title="New terminal in this chat" onClick={() => addTab(chatForNew())}>
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
              <div className="term-slots">
                {ck ? (
                  renderPane(viewLayout, [])
                ) : (
                  // No chat yet: nothing runs until the user starts one. Still a
                  // drop target, so dragging Claude / Codex here works too.
                  <div className="term-slot chat-empty" data-pane-id={MAIN}>
                    {repo ? (
                      <WorkspaceHome
                        ws={view}
                        label={repo.label}
                        path={repo.path}
                        branch={branches[view]}
                        onNew={(kind) => askChatName(view, kind)}
                        onOrchestrate={() => setOrchestrate(view)}
                        onResume={resumePast}
                        onReview={(mr) => void deliverToAgent({ newIn: view }, reviewPrompt(mr), true, `review !${mr.iid}`).catch((err) => setToast(String(err)))}
                        onOpenUrl={(url) => {
                          setBrowserOpen({ url, nonce: Date.now() });
                          setView("jira");
                        }}
                      />
                    ) : (
                      <p>No chats yet</p>
                    )}
                  </div>
                )}
              </div>
              {agentDrag?.drop && termPaneRef.current && (
                <DropPreview drop={agentDrag.drop} host={termPaneRef.current.getBoundingClientRect()} />
              )}
              {tabDrag?.drop && termPaneRef.current && (
                <DropPreview drop={tabDrag.drop} host={termPaneRef.current.getBoundingClientRect()} move />
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
                      <button className="pane-collapse" title="Hide panel" onClick={() => hideRight(true)}>»</button>
                    </nav>
                    {panelTab === "preview" && <Preview key={view} wsKey={view} />}
                    {panelTab === "tree" && <TestTree repo={view} />}
                    {panelTab === "pipelines" && (
                      <PipelinesPanel key={view} wsKey={view} onInfo={notePipelines} onCheck={checkPipeline} />
                    )}
                    {panelTab === "coverage" && (
                      <SuiteCoverage key={view} suite={repo.kind === "pytest" ? "api" : "e2e"} repoKey={view} />
                    )}
                    {panelTab === "browser" && (
                      <Browser
                        key="shared-browser"
                        wsKey={SHARED_BROWSER}
                        visible={!panelHidden && !overlayOpen}
                        network={settings.network}
                        picker={settings.picker}
                      />
                    )}
                  </>
                )}
              </section>
            }
            {rightHidden && hasPanel && (
              <button className="pane-reopen" title="Show panel" onClick={() => hideRight(false)}>
                «
              </button>
            )}
          </div>
        )}
        </div>
      </div>
      {sessionMenu && (
        <ContextMenu
          x={sessionMenu.x}
          y={sessionMenu.y}
          onClose={() => setSessionMenu(null)}
          groups={[
            ...(newSessionWs
              ? [
                  [
                    { label: `New Claude chat · ${config.repos[newSessionWs].label}`, icon: <ClaudeLogo />, onSelect: () => askChatName(newSessionWs, "claude") },
                    { label: "New Codex chat", icon: <CodexLogo />, onSelect: () => askChatName(newSessionWs, "codex") },
                    { label: "New terminal", icon: <TerminalIcon />, onSelect: () => askChatName(newSessionWs, "shell") },
                  ],
                ]
              : []),
            [
              ...(closedChats.current.length
                ? [{ label: "Reopen closed session", icon: MenuIcons.read, shortcut: "⌘⇧T", onSelect: () => reopenClosed() }]
                : []),
              { label: "Past sessions…", icon: MenuIcons.folder, onSelect: () => setView("sessions") },
            ],
          ]}
        />
      )}
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
              <p>This moves the folder to the Trash and removes it from Crux. You can restore it from the Trash.</p>
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
      {issueBar && !toast && (
        <div className="issue-bar">
          <span>Added to the chat</span>
          <button
            className="primary"
            onClick={() => {
              const { chat, path, issue } = issueBar;
              setIssueBar(null);
              void deliverToAgent({ chat }, jiraPrompt(issue, path, settings.jiraProject), true).catch((err) => setToast(String(err)));
            }}
          >
            File as Jira bug
          </button>
          <button onClick={() => setIssueBar(null)} title="Dismiss">×</button>
        </div>
      )}
      {searchOpen && config && (
        <ChatSearch
          items={paletteItems()}
          workspaces={searchWorkspaces}
          current={view}
          onResume={resumePast}
          onClose={() => setSearchOpen(false)}
        />
      )}
      {chatMenu && config.repos[chatMenu.key] && (
        <ContextMenu
          x={chatMenu.x}
          y={chatMenu.y}
          onClose={() => setChatMenu(null)}
          groups={[
            [
              { label: "New Claude chat", icon: <ClaudeLogo />, onSelect: () => askChatName(chatMenu.key, "claude") },
              { label: "New Codex chat", icon: <CodexLogo />, onSelect: () => askChatName(chatMenu.key, "codex") },
              { label: "New terminal", icon: <TerminalIcon />, onSelect: () => askChatName(chatMenu.key, "shell") },
            ],
            [{ label: "Orchestrate…", icon: <OrchestrateIcon />, onSelect: () => setOrchestrate(chatMenu.key) }],
          ]}
        />
      )}
      {shotPick && config && (
        <ChatPicker
          preview={shotPick.preview}
          active={trayChats}
          groups={Object.entries(config.repos).map(([ws, repo]) => ({
            ws,
            label: repo.label,
            chats: chatsOf(ws).map((chat) => ({
              chat,
              name: chatTitle(chat),
              kinds: [...new Set((tabs[chat] ?? []).map((t) => t.agent ?? "shell"))],
            })),
          }))}
          onPick={(to) => {
            const { path, preview, issue } = shotPick;
            setShotPick(null);
            URL.revokeObjectURL(preview);
            void pasteImage(to, path)
              .then((chat) => issue && setIssueBar({ chat, path, issue }))
              .catch((err) => setToast(String(err)));
          }}
          onCancel={() => {
            URL.revokeObjectURL(shotPick.preview);
            setShotPick(null);
          }}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          key={settingsPage}
          settings={settings}
          onChange={saveSettings}
          onClose={() => {
            setSettingsOpen(false);
            setSettingsPage("profile");
          }}
          onReplayIntro={() => {
            setSettingsOpen(false);
            setOnboarding("intro");
          }}
          browserSupported={config.browserSupported !== false}
          onPermissions={() => {
            setSettingsOpen(false);
            permsAlone.current = true;
            setOnboarding("permissions");
          }}
          userName={config.userName ?? ""}
          onRename={(name) => {
            setConfig((c) => (c ? { ...c, userName: name } : c));
            void api("/api/profile", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name }),
            });
          }}
          version={appVersion}
          canUpdate={!import.meta.env.DEV && "__TAURI_INTERNALS__" in window}
          update={update}
          onUpdateFound={(latest) => setUpdate((u) => u ?? { latest, installing: false })}
          onInstall={() => void installUpdate()}
          setupCount={setupCount}
          onSetupChecked={(tools) => setSetupCount(setupIssues(tools))}
          onFix={runInTerminal}
          initialPage={settingsPage}
        />
      )}
      {chatCtx && (() => {
        const t = (tabs[chatCtx.key] ?? [])[0];
        if (!t) return null;
        const kind = t.agent === "claude" || t.agent === "codex" ? t.agent : "shell";
        const label = kind === "shell" ? "terminal" : `${kind === "claude" ? "Claude" : "Codex"} chat`;
        return (
          <ContextMenu
            x={chatCtx.x}
            y={chatCtx.y}
            onClose={() => setChatCtx(null)}
            groups={[
              [
                { label: "Open", icon: kind === "claude" ? <ClaudeLogo /> : kind === "codex" ? <CodexLogo /> : <TerminalIcon />, onSelect: () => openChat(chatCtx.key) },
                { label: "Rename", icon: MenuIcons.rename, onSelect: () => setRenamingChat(chatCtx.key) },
                { label: `New ${label} here`, icon: MenuIcons.copy, onSelect: () => askChatName(wsOf(chatCtx.key), kind) },
              ],
              [
                { label: "Close chat", icon: MenuIcons.trash, danger: true, onSelect: () => requestClose({ key: chatCtx.key, id: "", name: chatCtx.name }) },
              ],
            ]}
          />
        );
      })()}
      {orchestrate && config.repos[orchestrate] && (
        <OrchestrateModal
          wsLabel={config.repos[orchestrate].label}
          onClose={() => setOrchestrate(null)}
          onStart={(opts) => {
            startOrchestrator(orchestrate, opts);
            setOrchestrate(null);
          }}
        />
      )}
      {nameChat && config.repos[nameChat.key] && (
        <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && setNameChat(null)}>
          <form
            className="modal chat-modal"
            role="dialog"
            onSubmit={(e) => {
              e.preventDefault();
              newChat(nameChat.key, nameChat.kind, nameChat.name);
              setNameChat(null);
            }}
          >
            <div className="chat-modal-head">
              <span className={`chat-modal-icon ${nameChat.kind}`}>
                {nameChat.kind === "claude" ? <ClaudeLogo /> : nameChat.kind === "codex" ? <CodexLogo /> : <TerminalIcon />}
              </span>
              <div>
                <div className="chat-modal-title">
                  New {nameChat.kind === "shell" ? "terminal" : `${nameChat.kind === "claude" ? "Claude" : "Codex"} chat`}
                </div>
                <div className="chat-modal-sub">in {config.repos[nameChat.key].label}</div>
              </div>
            </div>
            <input
              className="chat-name-input"
              value={nameChat.name}
              placeholder="Name this chat"
              spellCheck={false}
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setNameChat({ ...nameChat, name: e.target.value })}
            />
            <div className="chat-modal-foot">
              <span className="chat-modal-hint">
                <kbd>↵</kbd> create · <kbd>esc</kbd> cancel
              </span>
              <button type="button" onClick={() => setNameChat(null)}>Cancel</button>
              <button type="submit" className="primary">Create</button>
            </div>
          </form>
        </div>
      )}
      {confirmClose && (
        <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && setConfirmClose(null)}>
          <div
            className="modal chat-modal"
            role="alertdialog"
          >
            <div className="chat-modal-head">
              <span className="chat-modal-icon danger">{MenuIcons.trash}</span>
              <div>
                <div className="chat-modal-title">Close “{confirmClose.name}”?</div>
                <div className="chat-modal-sub">
                  {confirmClose.id ? "Its session" : "Every terminal in this chat"}
                  {config.repos[wsOf(confirmClose.key)] ? ` in ${config.repos[wsOf(confirmClose.key)].label}` : ""} will be stopped.
                </div>
              </div>
            </div>
            <div className="chat-modal-foot">
              <span className="chat-modal-hint" />
              <button onClick={() => setConfirmClose(null)} autoFocus>Cancel</button>
              <button
                className="danger-solid"
                onClick={() => {
                  doClose(confirmClose);
                  setConfirmClose(null);
                }}
              >
                Close chat
              </button>
            </div>
          </div>
        </div>
      )}
      {gitMenu && (
        <GitMenu
          anchor={gitMenu.anchor}
          mode={gitMenu.mode}
          target={gitMenu.target}
          branch={branches[view] ?? null}
          wsKey={view}
          onPick={(a) => runGitAction(a, gitMenu.mode, gitMenu.tabId)}
          onSwitchBranch={(b, create) => {
            const { tabId, mode } = gitMenu;
            send({ type: "term:input", id: tabId, data: branchSwitchText(b, create, mode) });
            setTimeout(() => send({ type: "term:input", id: tabId, data: "\r" }), 150);
            // Refresh the branch label once the switch has had a moment.
            setTimeout(() => refreshBranch(view), mode === "shell" ? 1200 : 8000);
          }}
          onClose={() => setGitMenu(null)}
        />
      )}
      {onboarding === "intro" && <Intro onDone={afterIntro} />}
      {onboarding === "name" && <NameStep initial={config?.userName ?? ""} onDone={saveName} />}
      {onboarding === "mode" && (
        <ModeStep
          initial={config?.settings?.mode ?? "qa"}
          onDone={(mode) => {
            if (mode !== settings.mode) saveSettings({ mode });
            // Permissions are macOS prompts: only in the desktop app.
            setOnboarding(IN_TAURI && IS_MAC ? "permissions" : "welcome");
          }}
        />
      )}
      {onboarding === "permissions" && (
        <PermissionsStep
          onDone={() => {
            localStorage.setItem(PERMS_SEEN, "1");
            setOnboarding(permsAlone.current ? null : "welcome");
            permsAlone.current = false;
          }}
        />
      )}
      {onboarding === "welcome" && <Welcome name={config?.userName ?? ""} mode={settings.mode} onNext={() => setOnboarding("setup")} onSkip={finishOnboarding} />}
      {onboarding === "setup" && config && (
        <FirstSetup
          name={config.userName ?? ""}
          repos={config.repos}
          mode={settings.mode}
          onAddWorkspace={(kind, title) => {
            setAddPreset(kind ? { kind, title: title ?? "Add workspace" } : null);
            setAdding(true);
          }}
          onStartChat={(key, kind, name) => {
            newChat(key, kind, name);
            finishOnboarding();
          }}
          onFinish={finishOnboarding}
        />
      )}
      {adding && (
        <AddWorkspace
          kind={addPreset?.kind}
          title={addPreset?.title}
          onClose={() => {
            setAdding(false);
            setAddPreset(null);
          }}
          onAdded={(key, repo) => {
            setAddPreset(null);
            onWorkspaceAdded(key, repo);
          }}
        />
      )}
      {tabDrag && (
        <div className="drag-ghost" style={{ left: tabDrag.x, top: tabDrag.y }}>
          {tabDrag.tab.agent === "claude" ? <ClaudeLogo /> : tabDrag.tab.agent === "codex" ? <CodexLogo /> : <TerminalIcon />} {tabDrag.tab.title}
        </div>
      )}
      {agentDrag && (
        <div className="drag-ghost" style={{ left: agentDrag.x, top: agentDrag.y }}>
          {agentDrag.cmd === "claude" ? <ClaudeLogo /> : agentDrag.cmd === "codex" ? <CodexLogo /> : <TerminalIcon />}{" "}
          {agentDrag.cmd === "shell" ? "terminal" : agentDrag.cmd}
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
function DropPreview({ drop, host, move }: { drop: Drop; host: DOMRect; move?: boolean }) {
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
      <span>{move && drop.side === "center" ? "Move here" : SIDE_LABEL[drop.side]}</span>
    </div>
  );
}
