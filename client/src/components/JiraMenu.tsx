import { useEffect, useRef, useState } from "react";
import type { Bookmark } from "./Browser";

/** Saved Jira links: name + URL, kept per user in localStorage. */
export function loadJiraBoards(): Bookmark[] {
  try {
    const saved = JSON.parse(localStorage.getItem("crux.jiraBoards") ?? "[]");
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

export function saveJiraBoards(boards: Bookmark[]): void {
  localStorage.setItem("crux.jiraBoards", JSON.stringify(boards));
}

/** A readable default name from a Jira URL. */
export function nameForJiraUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const p = u.pathname;
    const board = p.match(/projects\/([A-Z][A-Z0-9_]+)\/boards\/(\d+)/i);
    if (board) return `${board[1].toUpperCase()} board`;
    const issue = p.match(/browse\/([A-Z][A-Z0-9_]+-\d+)/i) ?? u.search.match(/selectedIssue=([A-Z][A-Z0-9_]+-\d+)/i);
    if (issue) return issue[1].toUpperCase();
    const project = p.match(/projects\/([A-Z][A-Z0-9_]+)/i);
    if (project) return `${project[1].toUpperCase()} ${/backlog/.test(p) ? "backlog" : /list/.test(p) ? "list" : "project"}`;
    if (/filter=|jql=/.test(u.search) || /\/filters?\b/.test(p)) return "Jira filter";
    if (/dashboards?\//.test(p)) return "Jira dashboard";
    return u.host.replace(/\.atlassian\.net$/, "");
  } catch {
    return raw;
  }
}

export default function JiraMenu({
  anchor,
  boards,
  onBoards,
  onOpen,
  onClose,
}: {
  anchor: DOMRect;
  boards: Bookmark[];
  onBoards: (next: Bookmark[]) => void;
  onOpen: (url: string) => void;
  onClose: () => void;
}) {
  const [link, setLink] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (boards.length === 0) inputRef.current?.focus();
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent) {
        if (e.key === "Escape") onClose();
        return;
      }
      // The Jira row toggles the menu itself; don't double-handle it here.
      if ((e.target as Element | null)?.closest?.("[data-menu-anchor='jira']")) return;
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", close);
    };
  }, [onClose, boards.length]);

  const add = () => {
    let url = link.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    try {
      new URL(url);
    } catch {
      setError("That doesn't look like a link");
      return;
    }
    if (boards.some((b) => b.url === url)) {
      onOpen(url);
      return;
    }
    const next = [...boards, { name: name.trim() || nameForJiraUrl(url), url }];
    onBoards(next);
    setLink("");
    setName("");
    setError("");
    onOpen(url);
  };

  // Open beside the button, clamped to the window.
  const top = Math.min(anchor.top, window.innerHeight - 320);
  const left = anchor.right + 8;

  return (
    <div className="jira-menu" ref={ref} style={{ top, left }} role="dialog" aria-label="Jira boards">
      <div className="jira-menu-head">Jira</div>
      {boards.length > 0 && (
        <div className="jira-boards">
          {boards.map((b) => (
            <div key={b.url} className="jira-board" onClick={() => onOpen(b.url)} title={b.url}>
              <span className="jira-board-dot" />
              <span className="jira-board-name">{b.name}</span>
              <button
                title="Remove"
                onClick={(e) => {
                  e.stopPropagation();
                  onBoards(boards.filter((x) => x.url !== b.url));
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <form
        className="jira-add"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input
          ref={inputRef}
          value={link}
          placeholder="Paste a Jira board or issue link"
          spellCheck={false}
          onChange={(e) => {
            setLink(e.target.value);
            setError("");
          }}
        />
        {link.trim() && (
          <input value={name} placeholder={`Name (${nameForJiraUrl(/^https?:/.test(link) ? link : `https://${link}`)})`} onChange={(e) => setName(e.target.value)} />
        )}
        <button type="submit" className="primary" disabled={!link.trim()}>
          Add & open
        </button>
        {error && <div className="jira-error">{error}</div>}
      </form>
    </div>
  );
}
