import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../net";

/**
 * Git actions for the active terminal. Agent tabs (claude / codex) get a
 * plain-language instruction; plain shells get the git command. Either way
 * the text is typed in and Enter is pressed (except where the shell needs
 * the user to finish the line, e.g. a new branch name).
 */

export interface GitAction {
  id: string;
  label: string;
  hint: string;
  agent: string;
  shell: string;
  /** Leave the shell line unsubmitted so the user can finish typing. */
  shellNoEnter?: boolean;
  group: number;
}

export const GIT_ACTIONS: GitAction[] = [
  {
    id: "status",
    label: "Status",
    hint: "What changed",
    agent: "Show git status",
    shell: "git status",
    group: 0,
  },
  {
    id: "pull",
    label: "Pull",
    hint: "Get latest for this branch",
    agent: "Pull the latest changes",
    shell: "git pull",
    group: 0,
  },
  {
    id: "commit",
    label: "Commit",
    hint: "Commit current changes",
    agent: "Commit the current changes",
    shell: "git add -A && git commit",
    group: 1,
  },
  {
    id: "push",
    label: "Push",
    hint: "Push this branch",
    agent: "Push this branch",
    shell: "git push -u origin HEAD",
    group: 1,
  },
  {
    id: "commit-push",
    label: "Commit & push",
    hint: "Both in one go",
    agent: "Commit and push the current changes",
    shell: "git add -A && git commit && git push -u origin HEAD",
    group: 1,
  },
  {
    id: "mr",
    label: "Create MR",
    hint: "Merge request on GitLab",
    agent: "Create a merge request for this branch",
    shell: "git push -u origin HEAD -o merge_request.create -o merge_request.remove_source_branch",
    group: 2,
  },
  {
    id: "branch",
    label: "New branch",
    hint: "Create and switch",
    agent: "Create a new branch for this work",
    shell: "git switch -c ",
    shellNoEnter: true,
    group: 2,
  },
  {
    id: "rebase",
    label: "Update from main",
    hint: "Rebase on default branch",
    agent: "Rebase this branch on main",
    shell: "git fetch origin && git rebase origin/$(git remote show origin | sed -n 's/.*HEAD branch: //p')",
    group: 2,
  },
  {
    id: "stash",
    label: "Stash",
    hint: "Park changes",
    agent: "Stash my changes",
    shell: "git stash",
    group: 3,
  },
  {
    id: "log",
    label: "Log",
    hint: "Last 15 commits",
    agent: "Show the last 15 commits",
    shell: "git log --oneline --decorate -15",
    group: 3,
  },
];

interface BranchList {
  current: string;
  local: { name: string; when: string }[];
  remote: { name: string; when: string }[];
}

const shellQuote = (b: string) => (/^[\w./-]+$/.test(b) ? b : `'${b.replace(/'/g, "'\\''")}'`);

/** What to type for a branch switch, for an agent or a shell. */
export function branchSwitchText(branch: string, create: boolean, mode: "agent" | "shell"): string {
  if (mode === "shell") return `git switch ${create ? "-c " : ""}${shellQuote(branch)}`;
  return create ? `Create and switch to branch ${branch}` : `Switch to branch ${branch}`;
}

function BranchPicker({
  wsKey,
  onBack,
  onSwitch,
}: {
  wsKey: string;
  onBack: () => void;
  onSwitch: (branch: string, create: boolean) => void;
}) {
  const [data, setData] = useState<BranchList | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    api(`/api/workspaces/${wsKey}/branches`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setData)
      .catch(() => setFailed(true));
  }, [wsKey]);

  const q = query.trim().toLowerCase();
  const local = useMemo(() => (data?.local ?? []).filter((b) => b.name.toLowerCase().includes(q)), [data, q]);
  const remote = useMemo(() => (data?.remote ?? []).filter((b) => b.name.toLowerCase().includes(q)), [data, q]);
  const exists = !!data && [...data.local, ...data.remote].some((b) => b.name === query.trim());
  const first = local.find((b) => b.name !== data?.current) ?? remote[0];

  return (
    <div className="branch-picker">
      <div className="branch-head">
        <button onClick={onBack} title="Back">
          ‹
        </button>
        <input
          ref={inputRef}
          value={query}
          placeholder={failed ? "Type a branch name" : "Find or create a branch…"}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            if (first && q) onSwitch(first.name, false);
            else if (query.trim()) onSwitch(query.trim(), !exists && !failed ? true : false);
          }}
        />
      </div>
      <div className="branch-list">
        {!data && !failed && <div className="branch-note">Loading branches…</div>}
        {failed && <div className="branch-note">Couldn't list branches. Type a name and press Enter.</div>}
        {local.map((b) => (
          <button
            key={b.name}
            className={`branch-row ${b.name === data?.current ? "current" : ""}`}
            disabled={b.name === data?.current}
            onClick={() => onSwitch(b.name, false)}
          >
            <span className="branch-mark">{b.name === data?.current ? "✓" : ""}</span>
            <span className="branch-name">{b.name}</span>
            <span className="branch-when">{b.when}</span>
          </button>
        ))}
        {remote.length > 0 && <div className="branch-section">origin</div>}
        {remote.map((b) => (
          <button key={`r-${b.name}`} className="branch-row" onClick={() => onSwitch(b.name, false)}>
            <span className="branch-mark" />
            <span className="branch-name">{b.name}</span>
            <span className="branch-when">{b.when}</span>
          </button>
        ))}
        {data && local.length === 0 && remote.length === 0 && !query.trim() && <div className="branch-note">No branches found.</div>}
        {query.trim() && !exists && !failed && (
          <button className="branch-row create" onClick={() => onSwitch(query.trim(), true)}>
            <span className="branch-mark">+</span>
            <span className="branch-name">Create & switch to “{query.trim()}”</span>
          </button>
        )}
      </div>
    </div>
  );
}

export default function GitMenu({
  anchor,
  mode,
  target,
  branch,
  wsKey,
  onPick,
  onSwitchBranch,
  onClose,
}: {
  wsKey: string;
  onSwitchBranch: (branch: string, create: boolean) => void;
  anchor: DOMRect;
  mode: "agent" | "shell";
  /** Name of the terminal the action goes to (shown when panes are split). */
  target?: string;
  branch: string | null;
  onPick: (action: GitAction) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [picking, setPicking] = useState(false);
  const [pos, setPos] = useState({ left: anchor.right - 260, top: anchor.bottom + 6 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    setPos({ left: Math.max(8, Math.min(anchor.right - w, window.innerWidth - w - 8)), top: anchor.bottom + 6 });
  }, [anchor, picking]);

  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent) {
        if (e.key === "Escape") onClose();
        return;
      }
      // The Git button toggles the menu itself; don't double-handle it here.
      if ((e.target as Element | null)?.closest?.("[data-menu-anchor='git']")) return;
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", close);
      window.removeEventListener("blur", close);
    };
  }, [onClose]);

  const groups = [0, 1, 2, 3].map((g) => GIT_ACTIONS.filter((a) => a.group === g));

  return (
    <div className="ctx-menu git-menu" ref={ref} style={pos} role="menu">
      <div className="git-menu-head">
        <span className="git-branch">{branch ?? "git"}</span>
        <span className={`git-mode ${mode}`}>
          {target ? `→ ${target} · ` : ""}
          {mode === "agent" ? "asks the agent" : "runs in shell"}
        </span>
      </div>
      {picking ? (
        <BranchPicker
          wsKey={wsKey}
          onBack={() => setPicking(false)}
          onSwitch={(b, create) => {
            onClose();
            onSwitchBranch(b, create);
          }}
        />
      ) : (
        <div className="ctx-group">
          <button role="menuitem" className="ctx-item" onClick={() => setPicking(true)}>
            <span className="ctx-label">Switch branch…</span>
            <span className="git-hint">Pick or create</span>
          </button>
        </div>
      )}
      {!picking && groups.map((items, gi) => (
        <div key={gi} className="ctx-group">
          {items.map((a) => (
            <button
              key={a.id}
              role="menuitem"
              className="ctx-item"
              title={mode === "agent" ? a.agent : a.shell}
              onClick={() => {
                onClose();
                onPick(a);
              }}
            >
              <span className="ctx-label">{a.label}</span>
              <span className="git-hint">{a.hint}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
