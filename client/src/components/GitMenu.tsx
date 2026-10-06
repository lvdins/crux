import { useEffect, useLayoutEffect, useRef, useState } from "react";

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
    agent: "Show git status and give me a short summary of what changed on this branch.",
    shell: "git status",
    group: 0,
  },
  {
    id: "pull",
    label: "Pull",
    hint: "Get latest for this branch",
    agent: "Pull the latest changes for the current branch (git pull). If there are conflicts, stop and tell me which files.",
    shell: "git pull",
    group: 0,
  },
  {
    id: "commit",
    label: "Commit",
    hint: "Commit current changes",
    agent: "Review the current changes and create a git commit with a clear, conventional message. Don't push.",
    shell: "git add -A && git commit",
    group: 1,
  },
  {
    id: "push",
    label: "Push",
    hint: "Push this branch",
    agent: "Push the current branch to origin, setting the upstream if needed.",
    shell: "git push -u origin HEAD",
    group: 1,
  },
  {
    id: "commit-push",
    label: "Commit & push",
    hint: "Both in one go",
    agent: "Commit the current changes with a clear, conventional message and push the branch to origin.",
    shell: "git add -A && git commit && git push -u origin HEAD",
    group: 1,
  },
  {
    id: "mr",
    label: "Create MR",
    hint: "Merge request on GitLab",
    agent:
      "Push this branch and create a GitLab merge request into the default branch with a clear title and a short description of the changes. Use glab if it's installed; otherwise use git push options (-o merge_request.create) and give me the MR link.",
    shell: "git push -u origin HEAD -o merge_request.create -o merge_request.remove_source_branch",
    group: 2,
  },
  {
    id: "branch",
    label: "New branch",
    hint: "Create and switch",
    agent: "Create and switch to a new git branch with a good name for the current work. Ask me for the name if it isn't clear.",
    shell: "git switch -c ",
    shellNoEnter: true,
    group: 2,
  },
  {
    id: "rebase",
    label: "Update from main",
    hint: "Rebase on default branch",
    agent: "Fetch origin and rebase the current branch onto the default branch. If there are conflicts, stop and tell me which files.",
    shell: "git fetch origin && git rebase origin/$(git remote show origin | sed -n 's/.*HEAD branch: //p')",
    group: 2,
  },
  {
    id: "stash",
    label: "Stash",
    hint: "Park changes",
    agent: "Stash my current changes with a descriptive message.",
    shell: "git stash push -u",
    group: 3,
  },
  {
    id: "log",
    label: "Log",
    hint: "Last 15 commits",
    agent: "Show the last 15 commits on this branch as a short list.",
    shell: "git log --oneline --decorate -15",
    group: 3,
  },
];

export default function GitMenu({
  anchor,
  mode,
  target,
  branch,
  onPick,
  onClose,
}: {
  anchor: DOMRect;
  mode: "agent" | "shell";
  /** Name of the terminal the action goes to (shown when panes are split). */
  target?: string;
  branch: string | null;
  onPick: (action: GitAction) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: anchor.right - 260, top: anchor.bottom + 6 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    setPos({ left: Math.max(8, Math.min(anchor.right - w, window.innerWidth - w - 8)), top: anchor.bottom + 6 });
  }, [anchor]);

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
      {groups.map((items, gi) => (
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
