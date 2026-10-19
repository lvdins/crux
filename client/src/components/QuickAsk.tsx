import { useEffect, useRef, useState } from "react";
import { api } from "../net";
import { IS_MAC, KEY } from "../platform";
import { ClaudeLogo, CodexLogo } from "./icons";

type Repo = { label: string; color?: string };
type Agent = "claude" | "codex";

const LAST_WS = "crux.quickWs";
const LAST_AGENT = "crux.quickAgent";
const read = (key: string) => {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
};
const save = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
};

/**
 * The ⌥Space window: a floating prompt (dark card, one accent, big type).
 * Pick the agent and workspace, Enter starts the chat there in the background
 * (Crux notifies when it's done); ⌘Enter also opens Crux on it.
 */
export default function QuickAsk() {
  const [repos, setRepos] = useState<Record<string, Repo>>({});
  const [ws, setWs] = useState(() => read(LAST_WS));
  const [agent, setAgent] = useState<Agent>(() => (read(LAST_AGENT) === "codex" ? "codex" : "claude"));
  const [text, setText] = useState("");
  const [shown, setShown] = useState(0);
  // Workspace list (our own, so it matches the card instead of the system menu).
  const [wsOpen, setWsOpen] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);

  const loadRepos = () =>
    api("/api/config")
      .then((r) => r.json())
      .then((c: { repos: Record<string, Repo> }) => {
        setRepos(c.repos);
        setWs((cur) => (c.repos[cur] ? cur : Object.keys(c.repos)[0] ?? ""));
      })
      .catch(() => undefined);

  // Shown again: fresh workspace list, focused, pops in.
  useEffect(() => {
    void loadRepos();
    box.current?.focus();
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen("quick:shown", () => {
        void loadRepos();
        setShown((n) => n + 1);
        setTimeout(() => box.current?.focus(), 30);
      }).then((fn) => (unlisten = fn)),
    );
    return () => unlisten?.();
  }, []);

  // The box grows with the text, up to a few lines.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 110)}px`;
  }, [text]);

  const tauri = async () => {
    const [{ invoke }, { emit }] = await Promise.all([import("@tauri-apps/api/core"), import("@tauri-apps/api/event")]);
    return { invoke, emit };
  };
  const hide = async () => (await tauri()).invoke("quick_hide");

  const send = async (open: boolean) => {
    const prompt = text.trim();
    if (!prompt || !ws) return;
    save(LAST_WS, ws);
    save(LAST_AGENT, agent);
    const { invoke, emit } = await tauri();
    await emit("quick:ask", { ws, text: prompt, agent });
    setText("");
    await invoke("quick_hide");
    if (open) await invoke("main_show");
  };

  const search = async () => {
    const { invoke, emit } = await tauri();
    await invoke("quick_hide");
    await invoke("main_show");
    await emit("menu:search-chats");
  };

  const keys = Object.keys(repos);
  const cycleWs = (dir: 1 | -1) => {
    if (!keys.length) return;
    setWs(keys[(keys.indexOf(ws) + dir + keys.length) % keys.length]);
  };
  const mod = IS_MAC ? "⌘" : "Ctrl+";

  return (
    <div className="qa-stage" data-tauri-drag-region>
      <div key={shown} className="qa-card">
        <div className="qa-input-row">
          <span className={`qa-agent-mark ${agent}`}>{agent === "claude" ? <ClaudeLogo /> : <CodexLogo />}</span>
          <textarea
            ref={box}
            rows={1}
            className="qa-input"
            placeholder={`Ask ${agent === "claude" ? "Claude" : "Codex"} anything…`}
            value={text}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                if (wsOpen) setWsOpen(false);
                else void hide();
              } else if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(e.metaKey || e.ctrlKey);
              } else if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void search();
              } else if (e.key === "Tab") {
                // Tab: next workspace (⇧Tab: previous); ⌘/Ctrl+J: switch agent.
                e.preventDefault();
                cycleWs(e.shiftKey ? -1 : 1);
              } else if (e.key.toLowerCase() === "j" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                setAgent((a) => (a === "claude" ? "codex" : "claude"));
              }
            }}
          />
        </div>
        <div className="qa-bar">
          <div className="qa-seg" role="radiogroup" aria-label="Agent">
            {(["claude", "codex"] as const).map((a) => (
              <button key={a} role="radio" aria-checked={agent === a} className={agent === a ? "on" : ""} onClick={() => setAgent(a)} title={`${mod}J switches`}>
                {a === "claude" ? <ClaudeLogo /> : <CodexLogo />}
                {a === "claude" ? "Claude" : "Codex"}
              </button>
            ))}
          </div>
          {keys.length === 0 ? (
            <span className="qa-hint">Add a workspace in Crux first</span>
          ) : (
            <div className="qa-ws-wrap">
              <button className={`qa-ws ${wsOpen ? "open" : ""}`} title="Workspace the agent works in · Tab switches" onClick={() => setWsOpen((o) => !o)}>
                <span className="qa-ws-dot" style={repos[ws]?.color ? { background: repos[ws].color } : undefined}>
                  {repos[ws]?.label[0]?.toUpperCase()}
                </span>
                <span className="qa-ws-name">{repos[ws]?.label}</span>
                <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2.5 3.75 5 6.25l2.5-2.5" />
                </svg>
              </button>
              {wsOpen && (
                <>
                  <div className="qa-ws-scrim" onClick={() => setWsOpen(false)} />
                  <div className="qa-ws-menu" role="listbox">
                    {keys.map((k) => (
                      <button
                        key={k}
                        role="option"
                        aria-selected={k === ws}
                        className={k === ws ? "on" : ""}
                        onClick={() => {
                          setWs(k);
                          setWsOpen(false);
                          box.current?.focus();
                        }}
                      >
                        <span className="qa-ws-dot" style={repos[k].color ? { background: repos[k].color } : undefined}>
                          {repos[k].label[0]?.toUpperCase()}
                        </span>
                        <span className="qa-ws-name">{repos[k].label}</span>
                        {k === ws && (
                          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
                          </svg>
                        )}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
          <span className="qa-keys" data-tauri-drag-region>
            <span>
              <kbd>↵</kbd> ask
            </span>
            <span>
              <kbd>{KEY.askOpen.replace("Enter", "↵")}</kbd> ask &amp; open
            </span>
            <span>
              <kbd>{KEY.quickSearch}</kbd> search
            </span>
          </span>
          <button className="qa-go" disabled={!text.trim() || !ws} onClick={() => void send(false)} title="Ask (↵)">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
