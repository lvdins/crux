import { useCallback, useEffect, useState } from "react";
import { notifyAllowed } from "../../notify";
import { useModalKeys } from "../../useModalKeys";

/** "restart": Screen Recording was asked for; macOS applies it once Crux restarts. */
type State = "granted" | "denied" | "unknown" | "restart";

const invoke = <T,>(cmd: string, args?: Record<string, unknown>) =>
  import("@tauri-apps/api/core").then(({ invoke }) => invoke<T>(cmd, args));

const LABEL: Record<State, string> = { granted: "Allowed", denied: "Not allowed", unknown: "Not asked yet", restart: "Restart needed" };

/**
 * Onboarding: what macOS will ask Crux for, and why, asked for up front
 * instead of mid-task. Also opened from Settings, and once for existing users.
 */
export default function PermissionsStep({ onDone }: { onDone: () => void }) {
  const [notes, setNotes] = useState<State>("unknown");
  const [screen, setScreen] = useState<State>("unknown");
  const [folders, setFolders] = useState<State>("unknown");
  const [missing, setMissing] = useState<string[]>([]);
  useModalKeys(true, { onEnter: onDone });

  // Notifications and Screen Recording can be checked without asking; folders can't.
  const refresh = useCallback(() => {
    void notifyAllowed(false).then((ok) => setNotes((s) => (ok ? "granted" : s)));
    void invoke<string>("screen_permission")
      .then((st) => setScreen((s) => (st === "granted" ? "granted" : st === "restart" ? "restart" : s)))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    refresh();
    // Back from System Settings: pick up what was switched on there.
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  const askNotes = async () => setNotes((await notifyAllowed(true)) ? "granted" : "denied");
  // Not granted right away: you switch it on in System Settings, then Crux must restart.
  const askScreen = async () => setScreen((await invoke<boolean>("request_screen_permission").catch(() => false)) ? "granted" : "restart");
  const askFolders = async () => {
    const res = await invoke<[string, boolean][]>("request_folder_access").catch(() => []);
    const no = res.filter(([, ok]) => !ok).map(([name]) => name);
    setMissing(no);
    setFolders(res.length && !no.length ? "granted" : "denied");
  };
  const settings = (pane: string) => void invoke("open_privacy", { pane }).catch(() => undefined);

  const rows: { title: string; why: string; state: State; ask: () => void; pane: string; note?: string }[] = [
    {
      title: "Notifications",
      why: "A banner when an agent finishes or needs your input, so you can work elsewhere meanwhile.",
      state: notes,
      ask: () => void askNotes(),
      pane: "Notifications",
    },
    {
      title: "Screen Recording",
      why: "For Screenshot to agent in the menu bar: drag a box anywhere and hand it to a chat. Crux only captures when you click it. Agents in Crux get this too, as in any terminal app.",
      state: screen,
      ask: () => void askScreen(),
      pane: "ScreenCapture",
      note: screen === "restart" ? "Switch Crux on in System Settings, then restart Crux (chats reopen)." : undefined,
    },
    {
      title: "Documents, Desktop and Downloads",
      why: "Your repos and the files agents read and write often live here, and so do your screenshots. macOS asks once per folder.",
      state: folders,
      ask: () => void askFolders(),
      pane: "FilesAndFolders",
      note: missing.length ? `Not allowed: ${missing.join(", ")}. Turn them on under Files and Folders.` : undefined,
    },
  ];

  return (
    <div className="onb-backdrop">
      <div className="onb-card perm-step" role="dialog" aria-label="Permissions">
        <h2>A few permissions</h2>
        <p>macOS asks for these the first time they're needed. Allow them now so nothing interrupts an agent later.</p>
        <div className="perm-list">
          {rows.map((r) => (
            <div key={r.title} className="perm-row">
              <div className="perm-text">
                <b>{r.title}</b>
                <span>{r.why}</span>
                {r.note && <span className="perm-note">{r.note}</span>}
              </div>
              <div className="perm-side">
                <span className={`perm-state ${r.state}`}>{LABEL[r.state]}</span>
                {r.state === "granted" ? null : r.state === "restart" ? (
                  <>
                    <button className="primary" onClick={() => void invoke("restart_app")}>
                      Restart Crux
                    </button>
                    <button className="onb-link" onClick={() => settings(r.pane)}>
                      Open Settings
                    </button>
                  </>
                ) : r.state === "denied" ? (
                  <button onClick={() => settings(r.pane)}>Open Settings</button>
                ) : (
                  <button className="primary" onClick={r.ask}>
                    Allow
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="onb-foot">
          <span className="onb-spacer" />
          <button className="onb-link" onClick={onDone}>
            Skip for now
          </button>
          <button className="primary" onClick={onDone}>
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
