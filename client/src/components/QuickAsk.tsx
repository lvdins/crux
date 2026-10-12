import { useEffect, useRef, useState } from "react";
import { api } from "../net";

type Repo = { label: string };

const LAST_WS = "crux.quickWs";

/**
 * The ⌥Space window: type a prompt, pick a workspace, Enter starts a Claude chat
 * there in the background (Crux notifies when it's done). ⌘Enter also opens Crux.
 */
export default function QuickAsk() {
  const [repos, setRepos] = useState<Record<string, Repo>>({});
  const [ws, setWs] = useState(() => {
    try {
      return localStorage.getItem(LAST_WS) ?? "";
    } catch {
      return "";
    }
  });
  const [text, setText] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);

  const loadRepos = () =>
    api("/api/config")
      .then((r) => r.json())
      .then((c: { repos: Record<string, Repo> }) => {
        setRepos(c.repos);
        setWs((cur) => (c.repos[cur] ? cur : Object.keys(c.repos)[0] ?? ""));
      })
      .catch(() => undefined);

  // Shown again: fresh workspace list, empty box, focused.
  useEffect(() => {
    void loadRepos();
    box.current?.focus();
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen("quick:shown", () => {
        void loadRepos();
        setTimeout(() => box.current?.focus(), 30);
      }).then((fn) => (unlisten = fn)),
    );
    return () => unlisten?.();
  }, []);

  const tauri = async () => {
    const [{ invoke }, { emit }] = await Promise.all([import("@tauri-apps/api/core"), import("@tauri-apps/api/event")]);
    return { invoke, emit };
  };
  const hide = async () => (await tauri()).invoke("quick_hide");

  const send = async (open: boolean) => {
    const prompt = text.trim();
    if (!prompt || !ws) return;
    try {
      localStorage.setItem(LAST_WS, ws);
    } catch {
      /* private mode */
    }
    const { invoke, emit } = await tauri();
    await emit("quick:ask", { ws, text: prompt });
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
  return (
    <div className="quick" data-tauri-drag-region>
      <textarea
        ref={box}
        className="quick-input"
        placeholder="Ask Claude anything… it runs in the background and Crux tells you when it's done"
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            void hide();
          } else if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send(e.metaKey || e.ctrlKey);
          } else if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void search();
          }
        }}
      />
      <div className="quick-bar" data-tauri-drag-region>
        {keys.length === 0 ? (
          <span className="quick-hint">Add a workspace in Crux first</span>
        ) : (
          <select className="quick-ws" value={ws} onChange={(e) => setWs(e.target.value)} title="Workspace the agent works in">
            {keys.map((k) => (
              <option key={k} value={k}>
                {repos[k].label}
              </option>
            ))}
          </select>
        )}
        <span className="quick-hint" data-tauri-drag-region>
          <kbd>Enter</kbd> ask · <kbd>⌘Enter</kbd> ask &amp; open · <kbd>⌘K</kbd> search chats · <kbd>Esc</kbd> close
        </span>
      </div>
    </div>
  );
}
