import { useCallback, useEffect, useState } from "react";
import { notifyAllowed } from "../../notify";
import { useModalKeys } from "../../useModalKeys";

type State = "granted" | "denied" | "unknown";

const invoke = <T,>(cmd: string, args?: Record<string, unknown>) =>
  import("@tauri-apps/api/core").then(({ invoke }) => invoke<T>(cmd, args));

const LABEL: Record<State, string> = { granted: "Allowed", denied: "Not allowed", unknown: "Not asked yet" };

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
    void invoke<boolean>("screen_permission")
      .then((ok) => setScreen((s) => (ok ? "granted" : s)))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    refresh();
    // Back from System Settings: pick up what was switched on there.
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  const askNotes = async () => setNotes((await notifyAllowed(true)) ? "granted" : "denied");
  const askScreen = async () => setScreen((await invoke<boolean>("request_screen_permission").catch(() => false)) ? "granted" : "denied");
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
      why: "Screenshot to agent: drag a box anywhere on screen and hand it to a chat. Agents and terminals in Crux get this too, as with any terminal app.",
      state: screen,
      ask: () => void askScreen(),
      pane: "ScreenCapture",
      note: screen === "denied" ? "Switch Crux on in System Settings, then quit and reopen Crux." : undefined,
    },
    {
      title: "Documents, Desktop and Downloads",
      why: "Your repos and the files agents read and write often live here. macOS asks once per folder.",
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
                {r.state === "granted" ? null : r.state === "denied" ? (
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
