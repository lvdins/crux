import { useEffect, useState } from "react";
import { api } from "../net";
import { KEY } from "../platform";
import type { PastChat } from "./ChatSearch";
import { ClaudeLogo, CodexLogo, TerminalIcon } from "./icons";
import { checkPrompt, type PipelineInfo } from "./PipelinesPanel";
import { TeamStrip, type TeamMember } from "./TrayPanel";

export interface InboxMr {
  source: "gitlab";
  host: string;
  project: string;
  iid: number;
  title: string;
  url: string;
  author: string;
  role: "review" | "assigned" | "mine";
  draft: boolean;
  updatedAt: string;
  ws: string | null;
}

interface ChatRow {
  chat: string;
  ws: string;
  wsLabel: string;
  name: string;
  kinds: string[];
}

const kindIcon = (k: string) => (k === "claude" ? <ClaudeLogo /> : k === "codex" ? <CodexLogo /> : <TerminalIcon />);

const ago = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 60) return `${Math.max(1, m)}m`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
};

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
};

const ROLE: Record<InboxMr["role"], string> = { review: "Review requested", assigned: "Assigned to you", mine: "Yours" };

/** The prompt "Review with Claude" sends: read the MR with glab, report, don't comment yet. */
export function reviewPrompt(mr: InboxMr): string {
  const read = `glab mr view ${mr.iid} -R https://${mr.host}/${mr.project} --comments and glab mr diff ${mr.iid} -R https://${mr.host}/${mr.project}`;
  return [
    `Review merge request "${mr.title}" (${mr.url}).`,
    `Read it with: ${read}`,
    "List real problems first (bugs, missing tests, risky changes) with file:line, then smaller notes. Don't post comments or approve until I say so.",
  ].join("\n");
}

/** Home: what needs you across every workspace, in one screen. */
export default function Home({
  userName,
  needs,
  agents,
  pipelines,
  workspaces,
  onOpenChat,
  onReview,
  onAskPipeline,
  onResume,
  onOpenUrl,
}: {
  userName: string;
  needs: (ChatRow & { event: "input" | "stop" })[];
  agents: (ChatRow & { workingSince?: number; waiting?: "input" | "stop"; team?: TeamMember[] })[];
  pipelines: { ws: string; wsLabel: string; info: PipelineInfo }[];
  workspaces: { ws: string; label: string }[];
  onOpenChat: (chat: string) => void;
  onReview: (mr: InboxMr) => void;
  onAskPipeline: (ws: string, prompt: string) => void;
  onResume: (ws: string, past: PastChat) => void;
  /** Opens a page in Crux's Browser view (the desktop app ignores target=_blank). */
  onOpenUrl: (url: string) => void;
}) {
  const [mrs, setMrs] = useState<null | { items: InboxMr[]; errors: string[] }>(null);
  const [mrBusy, setMrBusy] = useState(false);
  const [recent, setRecent] = useState<(PastChat & { ws: string })[] | null>(null);
  // Ticks the "Working · 3m" timers.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const loadMrs = (refresh = false) => {
    setMrBusy(true);
    api(`/api/inbox/mrs${refresh ? "?refresh=1" : ""}`)
      .then((r) => r.json())
      .then(setMrs)
      .catch(() => setMrs({ items: [], errors: ["Couldn't reach the Crux server"] }))
      .finally(() => setMrBusy(false));
  };
  // Every 5 minutes while Home is open, and when the window comes back.
  useEffect(() => {
    loadMrs();
    const t = setInterval(() => loadMrs(), 5 * 60_000);
    const back = () => loadMrs();
    window.addEventListener("focus", back);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", back);
    };
  }, []);

  const wsKeys = workspaces.map((w) => w.ws).join(",");
  useEffect(() => {
    let stale = false;
    Promise.all(
      workspaces.map((w) =>
        api(`/api/history/${w.ws}?q=`)
          .then((r) => (r.ok ? r.json() : { chats: [] }))
          .then((d: { chats: PastChat[] }) => d.chats.slice(0, 6).map((c) => ({ ...c, ws: w.ws })))
          .catch(() => []),
      ),
    ).then((all) => !stale && setRecent(all.flat().sort((a, b) => b.at.localeCompare(a.at)).slice(0, 6)));
    return () => {
      stale = true;
    };
  }, [wsKeys]); // eslint-disable-line react-hooks/exhaustive-deps

  const label = (ws: string | null) => (ws && workspaces.find((w) => w.ws === ws)?.label) || "";
  const failed = pipelines.flatMap((p) =>
    p.info.schedules.filter((s) => s.active && s.runs[0]?.status === "failed").map((s) => ({ ...p, s, run: s.runs[0] })),
  );
  const toReview = mrs?.items.filter((m) => m.role !== "mine") ?? [];
  const mine = mrs?.items.filter((m) => m.role === "mine") ?? [];
  const waiting = needs.length + toReview.length + failed.length;

  return (
    <section className="full-pane home">
      <div className="home-inner">
        <header className="home-head">
          <h1>
            {greeting()}
            {userName ? `, ${userName}` : ""}
          </h1>
          <p>
            {waiting === 0
              ? "Nothing is waiting for you."
              : `${waiting} thing${waiting === 1 ? "" : "s"} waiting for you.`}
          </p>
        </header>

        <div className="home-grid">
          <div className="home-card">
            <h3>
              Needs you <small>{needs.length || ""}</small>
            </h3>
            {needs.length === 0 ? (
              <p className="home-empty">No agent is waiting. Agents that finish or ask a question show up here.</p>
            ) : (
              needs.map((n) => (
                <button key={n.chat} className="home-row" onClick={() => onOpenChat(n.chat)}>
                  <span className={`home-dot ${n.event === "input" ? "warn" : "ok"}`} />
                  <span className="home-text">
                    <b>{n.name}</b>
                    <span>
                      {n.wsLabel} · {n.event === "input" ? "Needs your input" : "Finished"}
                    </span>
                  </span>
                  <span className="home-go">Open</span>
                </button>
              ))
            )}
          </div>

          <div className="home-card">
            <h3>
              Merge requests for you <small>{toReview.length || ""}</small>
              <button className="home-refresh" disabled={mrBusy} onClick={() => loadMrs(true)} title="Check again">
                {mrBusy ? "Checking…" : "Refresh"}
              </button>
            </h3>
            {!mrs ? (
              <p className="home-empty">Checking GitLab…</p>
            ) : toReview.length === 0 ? (
              <p className="home-empty">No merge requests are waiting for your review.</p>
            ) : (
              toReview.map((m) => <MrRow key={m.url} mr={m} wsLabel={label(m.ws)} onReview={onReview} onOpenUrl={onOpenUrl} />)
            )}
            {mrs && mrs.errors.length > 0 && (
              <p className="home-err" title={mrs.errors.join("\n")}>
                Couldn't check {mrs.errors.map((e) => e.split(":")[0]).join(", ")}. Is glab logged in? (Settings → Setup)
              </p>
            )}
          </div>

          <div className="home-card">
            <h3>
              Failed pipelines <small>{failed.length || ""}</small>
            </h3>
            {pipelines.length === 0 ? (
              <p className="home-empty">No scheduled pipelines yet. They come from your E2E and API workspaces.</p>
            ) : failed.length === 0 ? (
              <p className="home-empty">The latest scheduled runs all passed.</p>
            ) : (
              failed.map((f) => (
                <div key={`${f.ws}:${f.s.id}`} className="home-row static">
                  <span className="home-dot bad" />
                  <span className="home-text">
                    <b>{f.s.description}</b>
                    <span>
                      {f.wsLabel} · {f.run.tests ? `${f.run.tests.failed + f.run.tests.error} failed tests · ` : ""}
                      {ago(f.run.createdAt)} ago
                    </span>
                  </span>
                  <button className="home-link" onClick={() => onOpenUrl(f.run.webUrl)}>
                    Open
                  </button>
                  <button className="home-go" onClick={() => onAskPipeline(f.ws, checkPrompt(f.info, f.s))}>
                    Ask agent why
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="home-card">
            <h3>
              Your merge requests <small>{mine.length || ""}</small>
            </h3>
            {!mrs ? (
              <p className="home-empty">Checking GitLab…</p>
            ) : mine.length === 0 ? (
              <p className="home-empty">You have no open merge requests.</p>
            ) : (
              mine.map((m) => <MrRow key={m.url} mr={m} wsLabel={label(m.ws)} onReview={onReview} onOpenUrl={onOpenUrl} />)
            )}
          </div>

          <div className="home-card">
            <h3>
              Open agents <small>{agents.length || ""}</small>
              {agents.some((a) => a.workingSince) && (
                <span className="home-working-count">{agents.filter((a) => a.workingSince).length} working</span>
              )}
            </h3>
            {agents.length === 0 ? (
              <p className="home-empty">No Claude or Codex chats are open.</p>
            ) : (
              agents.map((a) => (
                <button key={a.chat} className="home-row" onClick={() => onOpenChat(a.chat)}>
                  <span className="home-icons">{a.kinds.slice(0, 2).map((k) => <span key={k}>{kindIcon(k)}</span>)}</span>
                  <span className="home-text">
                    <b>{a.name}</b>
                    <span>
                      {a.wsLabel} ·{" "}
                      {a.workingSince ? (
                        <em className="home-state working">Working · {ago(new Date(a.workingSince).toISOString())}</em>
                      ) : a.waiting === "input" ? (
                        <em className="home-state input">Needs your input</em>
                      ) : a.waiting === "stop" ? (
                        <em className="home-state done">Finished</em>
                      ) : (
                        "Idle"
                      )}
                    </span>
                    {a.team?.length ? <TeamStrip team={a.team} /> : null}
                  </span>
                  {a.workingSince && <span className="agent-spin" />}
                  <span className="home-go">Open</span>
                </button>
              ))
            )}
          </div>

          <div className="home-card">
            <h3>Recent conversations</h3>
            {!recent ? (
              <p className="home-empty">Loading…</p>
            ) : recent.length === 0 ? (
              <p className="home-empty">No past Claude or Codex conversations in your workspaces.</p>
            ) : (
              recent.map((c) => (
                <button key={c.id} className="home-row" onClick={() => onResume(c.ws, c)}>
                  <span className="home-icons">{kindIcon(c.kind)}</span>
                  <span className="home-text">
                    <b>{c.title}</b>
                    <span>
                      {label(c.ws)} · {ago(c.at)} ago
                    </span>
                  </span>
                  <span className="home-go">Resume</span>
                </button>
              ))
            )}
          </div>
        </div>
        <p className="home-foot">
          {KEY.quickAsk} from any app: ask an agent without opening Crux · {KEY.search}: search chats
        </p>
      </div>
    </section>
  );
}

function MrRow({
  mr,
  wsLabel,
  onReview,
  onOpenUrl,
}: {
  mr: InboxMr;
  wsLabel: string;
  onReview: (mr: InboxMr) => void;
  onOpenUrl: (url: string) => void;
}) {
  return (
    <div className="home-row static">
      <span className={`home-dot ${mr.role === "mine" ? "ok" : "warn"}`} />
      <span className="home-text">
        <b>
          {mr.draft && <em>Draft · </em>}
          {mr.title}
        </b>
        <span>
          {mr.project.split("/").pop()} !{mr.iid} · {mr.role === "mine" ? "" : `${mr.author} · `}
          {ROLE[mr.role]} · {ago(mr.updatedAt)} ago{wsLabel ? ` · ${wsLabel}` : ""}
        </span>
      </span>
      <button className="home-link" onClick={() => onOpenUrl(mr.url)}>
        Open
      </button>
      {mr.role !== "mine" && (
        <button className="home-go" onClick={() => onReview(mr)}>
          Review with Claude
        </button>
      )}
    </div>
  );
}
