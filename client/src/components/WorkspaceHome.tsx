import { useEffect, useState } from "react";
import { api } from "../net";
import type { PastChat } from "./ChatSearch";
import { MrRow, type InboxMr } from "./Home";
import { ClaudeLogo, CodexLogo, OrchestrateIcon, TerminalIcon } from "./icons";

const when = (iso: string) => {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86400_000);
  if (days < 1) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (days < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
};

/**
 * A workspace with no chat open: where you are (folder, branch), start
 * something, pick up a recent session here, or review this repo's open
 * merge requests.
 */
export default function WorkspaceHome({
  ws,
  label,
  path,
  branch,
  onNew,
  onOrchestrate,
  onResume,
  onReview,
  onOpenUrl,
}: {
  ws: string;
  label: string;
  path: string;
  branch?: string | null;
  onNew: (kind: "claude" | "codex" | "shell") => void;
  onOrchestrate: () => void;
  onResume: (ws: string, past: PastChat) => void;
  onReview: (mr: InboxMr) => void;
  onOpenUrl: (url: string) => void;
}) {
  const [recent, setRecent] = useState<(PastChat & { branch?: string })[] | null>(null);
  const [mrs, setMrs] = useState<InboxMr[]>([]);

  useEffect(() => {
    let stale = false;
    setRecent(null);
    void api(`/api/history/${encodeURIComponent(ws)}`)
      .then((r) => r.json())
      .then((d: { chats?: PastChat[] }) => !stale && setRecent((d.chats ?? []).slice(0, 6)))
      .catch(() => !stale && setRecent([]));
    void api("/api/inbox/mrs")
      .then((r) => r.json())
      .then((d: { items?: InboxMr[] }) => !stale && setMrs((d.items ?? []).filter((m) => m.ws === ws).slice(0, 5)))
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [ws]);

  return (
    <div className="ws-home">
      <div className="ws-home-head">
        <h2>{label}</h2>
        <p>
          <code>{path.replace(/^\/Users\/[^/]+/, "~")}</code>
          {branch && <span className="ws-home-branch">{branch}</span>}
        </p>
      </div>
      <div className="ws-home-start">
        <button className="primary" onClick={() => onNew("claude")}>
          <ClaudeLogo /> Start Claude here
        </button>
        <button onClick={() => onNew("codex")}>
          <CodexLogo /> Codex
        </button>
        <button onClick={() => onNew("shell")}>
          <TerminalIcon /> Terminal
        </button>
        <button onClick={onOrchestrate}>
          <OrchestrateIcon /> Orchestrate
        </button>
      </div>
      {(recent === null || recent.length > 0) && (
        <div className="home-card ws-home-card">
          <h3>Recent sessions here</h3>
          {recent === null ? (
            <p className="home-empty">Loading…</p>
          ) : (
            recent.map((c) => (
              <button key={c.id} className="home-row" onClick={() => onResume(ws, c)} title={c.prompt}>
                <span className="home-icons">{c.kind === "claude" ? <ClaudeLogo /> : <CodexLogo />}</span>
                <span className="home-text">
                  <b>{c.title || c.prompt.slice(0, 60)}</b>
                  <span>
                    {when(c.at)}
                    {c.branch ? ` · ${c.branch}` : ""}
                  </span>
                </span>
                <span className="home-go">Resume</span>
              </button>
            ))
          )}
        </div>
      )}
      {mrs.length > 0 && (
        <div className="home-card ws-home-card">
          <h3>Open merge requests</h3>
          {mrs.map((m) => (
            <MrRow key={m.url} mr={m} wsLabel="" onReview={onReview} onOpenUrl={onOpenUrl} />
          ))}
        </div>
      )}
    </div>
  );
}
