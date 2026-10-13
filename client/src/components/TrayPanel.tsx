import { useEffect, useRef, useState } from "react";
import { ClaudeLogo, CodexLogo, TerminalIcon } from "./icons";

/** An agent chat as the main window sends it (App.tsx → set_tray_chats). */
export interface TrayAgent {
  chat: string;
  name: string;
  wsLabel: string;
  kinds: string[];
  workingSince?: number;
  waiting?: "input" | "stop";
  /** Latest line from Claude's hooks: prompt, tool, question or reply. */
  detail?: string;
}

const kindIcon = (k: string) => (k === "claude" ? <ClaudeLogo /> : k === "codex" ? <CodexLogo /> : <TerminalIcon />);

const took = (since: number, now: number) => {
  const m = Math.floor((now - since) / 60_000);
  return m < 1 ? "just started" : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

const invoke = (cmd: string, args?: Record<string, unknown>) =>
  import("@tauri-apps/api/core").then(({ invoke }) => invoke(cmd, args)).catch(() => undefined);

/**
 * The menu bar panel (click the Crux icon): open agents, styled like Home's
 * card, with what each one is doing. A row opens that chat in Crux.
 */
export default function TrayPanel() {
  const [agents, setAgents] = useState<TrayAgent[]>([]);
  const [now, setNow] = useState(() => Date.now());
  // Pops out of the menu bar each time it's shown; resets once hidden.
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void invoke("tray_chats").then((list) => Array.isArray(list) && setAgents(list as TrayAgent[]));
    const pop = () => {
      setOpen(false);
      requestAnimationFrame(() => requestAnimationFrame(() => setOpen(true)));
    };
    pop();
    const unlisten: (() => void)[] = [];
    void import("@tauri-apps/api/event").then(({ listen }) => {
      void listen<TrayAgent[]>("tray:chats", (e) => setAgents(e.payload)).then((fn) => unlisten.push(fn));
      void listen("tray:shown", () => {
        setNow(Date.now());
        pop();
      }).then((fn) => unlisten.push(fn));
    });
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && void invoke("tray_action", { action: "hide" });
    const blur = () => setOpen(false);
    window.addEventListener("keydown", esc);
    window.addEventListener("blur", blur);
    return () => {
      unlisten.forEach((fn) => fn());
      clearInterval(tick);
      window.removeEventListener("keydown", esc);
      window.removeEventListener("blur", blur);
    };
  }, []);

  // The window is as tall as the panel (offsetHeight: ignores the pop transform).
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const fit = () => void invoke("tray_fit", { height: el.offsetHeight });
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const busy = agents.filter((a) => a.workingSince).length;

  return (
    <div className={`tray-panel ${open ? "open" : ""}`} ref={root}>
      <div className="home-card tray-card">
        <h3>
          Open agents <small>{agents.length || ""}</small>
          {busy > 0 && <span className="home-working-count">{busy} working</span>}
        </h3>
        {agents.length === 0 ? (
          <p className="home-empty">No Claude or Codex chats are open.</p>
        ) : (
          <div className="tray-list">
            {agents.map((a) => (
              <button key={a.chat} className="home-row" onClick={() => void invoke("tray_action", { action: "chat", chat: a.chat })}>
                <span className="home-icons">{a.kinds.slice(0, 2).map((k) => <span key={k}>{kindIcon(k)}</span>)}</span>
                <span className="home-text">
                  <b>{a.name}</b>
                  <span>
                    {a.wsLabel} ·{" "}
                    {a.workingSince ? (
                      <em className="home-state working">Working · {took(a.workingSince, now)}</em>
                    ) : a.waiting === "input" ? (
                      <em className="home-state input">Needs your input</em>
                    ) : a.waiting === "stop" ? (
                      <em className="home-state done">Finished</em>
                    ) : (
                      "Idle"
                    )}
                  </span>
                  {a.detail && <span className="tray-detail">{a.detail}</span>}
                </span>
                {a.workingSince && <span className="agent-spin" />}
                <span className="home-go">Open</span>
              </button>
            ))}
          </div>
        )}
        <div className="tray-foot">
          <button onClick={() => void invoke("tray_action", { action: "open" })}>Open Crux</button>
          <button onClick={() => void invoke("tray_action", { action: "quick" })}>
            Quick Ask <kbd>⌥Space</kbd>
          </button>
          <button title="Drag a box anywhere on screen, then pick the agent it goes to" onClick={() => void invoke("tray_action", { action: "capture" })}>
            Screenshot to agent
          </button>
        </div>
      </div>
    </div>
  );
}
