import { useEffect, useState } from "react";
import { api } from "../net";
import { notify, notifyAllowed } from "../notify";
import type { Settings } from "../types";
import { useModalKeys } from "../useModalKeys";
import SetupChecklist, { type ToolHealth } from "./SetupChecklist";

type Key = Exclude<keyof Settings, "mode" | "defaultChat" | "jiraProject">;
interface Toggle {
  key: Key;
  label: string;
  hint: string;
  /** Shown indented; off while its parent is off. */
  parent?: Key;
}
type Group = { title: string; toggles: Toggle[] };

const VIEW_GROUPS: Group[] = [
  {
    title: "Workspace panel",
    toggles: [
      { key: "docPreview", label: "Doc preview", hint: "Live preview for MkDocs folders." },
      { key: "tests", label: "Tests", hint: "Test tree for Playwright / pytest folders." },
      { key: "coverage", label: "Coverage", hint: "Which features the tests cover." },
      { key: "pipelines", label: "Pipelines", hint: "Morning / evening scheduled GitLab runs, and the sidebar status dot." },
      { key: "browser", label: "Browser", hint: "A browser beside your chats. When off, agents still use a hidden browser through MCP." },
      { key: "network", label: "Network view", hint: "Fetch / XHR calls under the browser.", parent: "browser" },
      { key: "picker", label: "Element picker", hint: "Pick an element to get Playwright locators.", parent: "browser" },
    ],
  },
  {
    title: "Sidebar",
    toggles: [
      { key: "connections", label: "Connections", hint: "Features across frontend, backend and test repos." },
      { key: "connCoverage", label: "Coverage", hint: "Feature list with API / E2E coverage.", parent: "connections" },
      { key: "connGraph", label: "Graph", hint: "The same as a graph.", parent: "connections" },
      { key: "jira", label: "Browser view", hint: "A full browser for any website, next to your workspaces." },
    ],
  },
];

const CHAT_TOGGLES: Group = {
  title: "When making or closing chats",
  toggles: [
    { key: "askChatName", label: "Ask for a name", hint: "Off: new chats are named “claude”, “claude 2”, … and you can rename them later." },
    { key: "confirmClose", label: "Ask before closing", hint: "Off: × closes a chat or terminal right away." },
  ],
};

const NOTIFY_TOGGLES: Group = {
  title: "Notify me when",
  toggles: [
    { key: "notifyAgent", label: "An agent finishes or needs input", hint: "Only when you're in another app or another chat. The chat also gets a dot in the sidebar." },
    { key: "notifyPipeline", label: "A scheduled pipeline fails", hint: "Morning / evening runs of your E2E and API workspaces (checked every 10 minutes)." },
  ],
};

const IN_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const BACKGROUND_TOGGLES: Group = {
  title: "Keep Crux around",
  toggles: [
    { key: "keepRunning", label: "Keep running when the window is closed", hint: "Crux stays in the menu bar: agents keep working and you still get notified. ⌘Q quits." },
    { key: "quickAsk", label: "Quick ask with ⌥Space", hint: "From any app: type a prompt, Enter starts a Claude chat in the background." },
  ],
};
const HOME_TOGGLES: Group = {
  title: "When Crux opens",
  toggles: [{ key: "openHome", label: "Start on Home", hint: "What needs you: waiting agents, merge requests, failed pipelines. Off: the last workspace you had open." }],
};

const DEFAULT_CHAT: { value: Settings["defaultChat"]; label: string }[] = [
  { value: "pick", label: "Ask each time" },
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
  { value: "shell", label: "Terminal" },
];

const SHORTCUTS: [string, string][] = [
  ["⌘ S", "Show / hide the sidebar"],
  ["⌘ B", "Show / hide the workspace panel"],
  ["⌘ K", "Search chats and past conversations"],
  ["⌥ Space", "Quick ask, from any app (desktop app)"],
  ["⌘ ⇧ C", "Mark an issue in the browser"],
  ["⌘ ⇧ ⌫", "Delete the open workspace"],
  ["⇧ Enter", "New line in a chat"],
  ["Enter / Esc", "Confirm / cancel a dialog"],
];

const MODES: { mode: Settings["mode"]; title: string; body: string }[] = [
  { mode: "qa", title: "QA Tool", body: "Everything on: docs, tests, coverage, pipelines, browser and QA views." },
  { mode: "regular", title: "Regular", body: "Just chats and agents on any folder; everything else off." },
];

const PAGES = [
  ["profile", "Profile"],
  ["setup", "Setup"],
  ["tabs", "Tabs & views"],
  ["chats", "Chats"],
  ["notify", "Notifications"],
  ["background", "Background"],
  ["keys", "Shortcuts"],
  ["mode", "Mode"],
] as const;
type Page = (typeof PAGES)[number][0];

/** Settings, one page per topic. Changes save right away. */
export default function SettingsModal({
  settings,
  onChange,
  onClose,
  onReplayIntro,
  userName,
  onRename,
  version,
  canUpdate,
  update,
  onUpdateFound,
  onInstall,
  setupCount,
  onSetupChecked,
  onFix,
}: {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onClose: () => void;
  /** Replays the intro + welcome + setup guide. */
  onReplayIntro: () => void;
  userName: string;
  onRename: (name: string) => void;
  version: string;
  /** Updates work only in the installed app. */
  canUpdate: boolean;
  update: null | { latest: string; installing: boolean };
  onUpdateFound: (latest: string) => void;
  onInstall: () => void;
  /** Required tools missing or logged out. */
  setupCount: number;
  onSetupChecked: (tools: ToolHealth[]) => void;
  /** Runs an install / login command in a terminal. */
  onFix: (cmd: string, tool: string) => void;
}) {
  const [page, setPage] = useState<Page>("profile");
  const [name, setName] = useState(userName);
  const [jira, setJira] = useState(settings.jiraProject);
  const [checking, setChecking] = useState<"" | "busy" | "latest" | "error">("");
  const [blocked, setBlocked] = useState(false);
  // Start at login lives in macOS (a LaunchAgent), not in Crux's settings.
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [installed, setInstalled] = useState(true);
  useEffect(() => {
    if (!IN_TAURI) return;
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<boolean>("in_applications"))
      .then(setInstalled)
      .catch(() => undefined);
    void import("@tauri-apps/plugin-autostart")
      .then((a) => a.isEnabled())
      .then(setAutostart)
      .catch(() => setAutostart(false));
  }, []);
  const toggleAutostart = async (on: boolean) => {
    const a = await import("@tauri-apps/plugin-autostart");
    await (on ? a.enable() : a.disable()).catch(() => undefined);
    setAutostart(await a.isEnabled().catch(() => false));
  };
  const saveName = () => {
    const next = name.trim();
    if (next && next !== userName) onRename(next);
    else setName(userName);
  };
  useModalKeys(true, {
    onEnter: () => {
      if (page === "profile") {
        saveName();
        if (jira.trim() !== settings.jiraProject) onChange({ jiraProject: jira.trim() });
      }
      onClose();
    },
    onEscape: onClose,
  });

  const checkUpdate = async () => {
    setChecking("busy");
    try {
      const u = (await (await api(`/api/update?current=${version}`)).json()) as { latest: string | null; available: boolean };
      if (u.available && u.latest) {
        onUpdateFound(u.latest);
        setChecking("");
      } else setChecking(u.latest ? "latest" : "error");
    } catch {
      setChecking("error");
    }
  };

  // Turning a notification on asks macOS for permission the first time.
  const change = async (key: Key, on: boolean) => {
    onChange({ [key]: on });
    if (on && (key === "notifyAgent" || key === "notifyPipeline")) setBlocked(!(await notifyAllowed(true)));
  };

  const toggles = (g: Group) => (
    <div key={g.title}>
      <div className="settings-section">{g.title}</div>
      <div className="settings-list">
        {g.toggles.map((t) => {
          const off = !!t.parent && !settings[t.parent];
          return (
            <label key={t.key} className={`settings-row ${t.parent ? "child" : ""} ${off ? "disabled" : ""}`}>
              <span className="settings-text">
                <b>{t.label}</b>
                <span>{t.hint}</span>
              </span>
              <input
                type="checkbox"
                className="settings-switch"
                checked={settings[t.key] && !off}
                disabled={off}
                onChange={(e) => void change(t.key, e.target.checked)}
              />
            </label>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings-modal" role="dialog" aria-label="Settings">
        <div className="settings-head">
          <h2>Settings</h2>
          <button className="modal-x" title="Close (Esc)" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="settings-body">
          <nav className="settings-nav" role="tablist">
            {PAGES.map(([id, label]) => (
              <button key={id} role="tab" className={page === id ? "on" : ""} onClick={() => setPage(id)}>
                {label}
                {id === "setup" && setupCount > 0 && <span className="nav-count">{setupCount}</span>}
              </button>
            ))}
          </nav>

          <div className="settings-page">
            {page === "profile" && (
              <>
                <div className="settings-section">Your name</div>
                <input
                  className="settings-input"
                  value={name}
                  maxLength={60}
                  placeholder="What should Crux call you?"
                  onChange={(e) => setName(e.target.value)}
                  onBlur={saveName}
                />
                <div className="settings-section">Jira project for bugs</div>
                <input
                  className="settings-input"
                  value={jira}
                  maxLength={40}
                  placeholder="e.g. QA (blank: the agent asks each time)"
                  onChange={(e) => setJira(e.target.value.replace(/[^\w -]/g, ""))}
                  onBlur={() => jira.trim() !== settings.jiraProject && onChange({ jiraProject: jira.trim() })}
                />
                <p className="settings-note">
                  Used by “File as Jira bug” after you mark an issue with ⌘⇧C. The agent files it with its own Jira access.
                </p>
                <div className="settings-section">Crux</div>
                <div className="settings-list">
                  <div className="settings-row static">
                    <span className="settings-text">
                      <b>Version {version}</b>
                      <span>
                        {!canUpdate
                          ? "Updates work in the installed app."
                          : update
                            ? `Version ${update.latest.replace(/^v/, "")} is available.`
                            : checking === "latest"
                              ? "You're on the latest version."
                              : checking === "error"
                                ? "Couldn't reach GitHub. Is gh logged in?"
                                : "Crux checks for updates every 6 hours."}
                      </span>
                    </span>
                    {canUpdate &&
                      (update ? (
                        <button className="settings-btn-sm primary" disabled={update.installing} onClick={onInstall}>
                          {update.installing ? "Updating…" : "Install & restart"}
                        </button>
                      ) : (
                        <button className="settings-btn-sm" disabled={checking === "busy"} onClick={() => void checkUpdate()}>
                          {checking === "busy" ? "Checking…" : "Check for updates"}
                        </button>
                      ))}
                  </div>
                </div>
              </>
            )}

            {page === "setup" && (
              <>
                <p className="settings-note first">
                  The tools Crux uses, and whether you're logged in. “Log in” and “Install” run the command in a new terminal
                  chat.
                </p>
                <SetupChecklist onFix={onFix} onChecked={onSetupChecked} />
              </>
            )}

            {page === "tabs" && VIEW_GROUPS.map(toggles)}

            {page === "chats" && (
              <>
                <div className="settings-section">The + next to a workspace makes</div>
                <div className="settings-choice">
                  {DEFAULT_CHAT.map((c) => (
                    <button
                      key={c.value}
                      className={settings.defaultChat === c.value ? "on" : ""}
                      onClick={() => onChange({ defaultChat: c.value })}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
                <p className="settings-note">Right-click a chat to make any other kind.</p>
                {toggles(CHAT_TOGGLES)}
              </>
            )}

            {page === "notify" && (
              <>
                {toggles(NOTIFY_TOGGLES)}
                {blocked && (
                  <p className="settings-note warn">
                    macOS is blocking Crux's notifications. Allow them in System Settings → Notifications → Crux.
                  </p>
                )}
                <button className="settings-replay" onClick={() => void notify("Crux", "Notifications are working.")}>
                  Send a test notification
                </button>
              </>
            )}

            {page === "background" && (
              <>
                {!IN_TAURI && <p className="settings-note first">These work in the desktop app.</p>}
                <div className="settings-section">{BACKGROUND_TOGGLES.title}</div>
                <div className="settings-list">
                  {BACKGROUND_TOGGLES.toggles.map((t) => (
                    <label key={t.key} className={`settings-row ${IN_TAURI ? "" : "disabled"}`}>
                      <span className="settings-text">
                        <b>{t.label}</b>
                        <span>{t.hint}</span>
                      </span>
                      <input
                        type="checkbox"
                        className="settings-switch"
                        checked={settings[t.key]}
                        disabled={!IN_TAURI}
                        onChange={(e) => void change(t.key, e.target.checked)}
                      />
                    </label>
                  ))}
                  <label className={`settings-row ${IN_TAURI ? "" : "disabled"}`}>
                    <span className="settings-text">
                      <b>Start at login</b>
                      <span>
                        {installed
                          ? "Crux opens hidden in the menu bar when you log in to your Mac."
                          : "Move Crux to the Applications folder first."}
                      </span>
                    </span>
                    <input
                      type="checkbox"
                      className="settings-switch"
                      checked={!!autostart}
                      disabled={!IN_TAURI || autostart === null || (!installed && !autostart)}
                      onChange={(e) => void toggleAutostart(e.target.checked)}
                    />
                  </label>
                </div>
                {toggles(HOME_TOGGLES)}
              </>
            )}

            {page === "keys" && (
              <>
                <div className="settings-section">Keyboard shortcuts</div>
                <div className="settings-list">
                  {SHORTCUTS.map(([keys, what]) => (
                    <div key={keys} className="settings-row static">
                      <span className="settings-text">
                        <b>{what}</b>
                      </span>
                      <kbd className="settings-kbd">{keys}</kbd>
                    </div>
                  ))}
                </div>
              </>
            )}

            {page === "mode" && (
              <>
                <p className="settings-note">
                  A mode is a starting point: picking one turns the tabs on or off to match. You can still change any tab
                  afterwards. Chat and notification settings stay as they are.
                </p>
                <div className="settings-modes">
                  {MODES.map((m) => (
                    <button
                      key={m.mode}
                      className={`settings-mode ${settings.mode === m.mode ? "on" : ""}`}
                      onClick={() => settings.mode !== m.mode && onChange({ mode: m.mode })}
                    >
                      <b>{m.title}</b>
                      <span>{m.body}</span>
                    </button>
                  ))}
                </div>
                <button className="settings-replay" onClick={onReplayIntro}>
                  Replay intro &amp; setup guide
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
