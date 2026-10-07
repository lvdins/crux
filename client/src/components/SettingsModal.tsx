import type { Settings } from "../types";
import { useModalKeys } from "../useModalKeys";

const TOGGLES: { key: Exclude<keyof Settings, "mode">; label: string; hint: string; needsBrowser?: boolean }[] = [
  {
    key: "browser",
    label: "Browser panel",
    hint: "A browser beside your chats. When off, agents still use a hidden browser through MCP to check pages.",
  },
  { key: "network", label: "Network view", hint: "Fetch / XHR calls of the page, under the browser.", needsBrowser: true },
  { key: "picker", label: "Element picker", hint: "Pick an element on the page to get Playwright locators.", needsBrowser: true },
  { key: "qaPanels", label: "QA panels", hint: "Doc preview for MkDocs folders, Tests and Coverage for Playwright / pytest." },
  { key: "connections", label: "Connections view", hint: "Map of features across frontend, backend and test repos." },
  { key: "jira", label: "Jira view", hint: "Your Jira boards inside Crux." },
];

const MODES: { mode: Settings["mode"]; title: string; body: string }[] = [
  { mode: "qa", title: "QA Tool", body: "Docs, tests, coverage, browser and QA views" },
  { mode: "regular", title: "Regular", body: "Chats and agents on any folder" },
];

/** Settings: mode preset + one toggle per feature. Changes save right away. */
export default function SettingsModal({
  settings,
  onChange,
  onClose,
  onReplayIntro,
}: {
  /** Replays the intro + welcome + setup guide. */
  onReplayIntro: () => void;
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onClose: () => void;
}) {
  useModalKeys(true, { onEnter: onClose, onEscape: onClose });

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings-modal" role="dialog" aria-label="Settings">
        <div className="settings-head">
          <h2>Settings</h2>
          <button className="modal-x" title="Close (Esc)" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="settings-section">Mode</div>
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
        <p className="settings-note">Switching mode resets the toggles below to that mode's defaults.</p>

        <div className="settings-section">Features</div>
        <div className="settings-list">
          {TOGGLES.map((t) => {
            const off = t.needsBrowser && !settings.browser;
            return (
              <label key={t.key} className={`settings-row ${off ? "disabled" : ""}`}>
                <span className="settings-text">
                  <b>{t.label}</b>
                  <span>{off ? "Turn on the browser panel first." : t.hint}</span>
                </span>
                <input
                  type="checkbox"
                  className="settings-switch"
                  checked={settings[t.key] && !off}
                  disabled={off}
                  onChange={(e) => onChange({ [t.key]: e.target.checked })}
                />
              </label>
            );
          })}
        </div>

        <button className="settings-replay" onClick={onReplayIntro}>
          Replay intro &amp; setup guide
        </button>
      </div>
    </div>
  );
}
