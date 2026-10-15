import { useEffect, useState } from "react";
import { api } from "../net";
import { IS_MAC } from "../platform";
import { ClaudeLogo, CodexLogo, OrchestrateIcon } from "./icons";

export interface OrchestrateOpts {
  task: string;
  /** Most workers at once. */
  max: number;
  kind: "claude" | "codex" | "mix";
  /** Claude model alias for the lead and Claude workers; "default" = your Claude setting. */
  model: string;
  /** Codex model for Codex workers (an id from Codex's model list); "default" = your Codex setting. */
  codexModel: string;
  /** The lead shows its plan and waits for your OK. */
  approve: boolean;
}

const PREFS = "crux.orchestrate";
/** Aliases: Claude Code resolves each to the newest model of that family. */
const MODELS = [
  ["opus", "Opus"],
  ["sonnet", "Sonnet"],
  ["fable", "Fable"],
  ["default", "Default"],
] as const;
const loadPrefs = (): Omit<OrchestrateOpts, "task"> => {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS) ?? "{}");
    return {
      max: [1, 2, 3, 4, 5].includes(p.max) ? p.max : 3,
      kind: ["claude", "codex", "mix"].includes(p.kind) ? p.kind : "claude",
      model: MODELS.some(([m]) => m === p.model) ? p.model : "opus",
      codexModel: typeof p.codexModel === "string" && p.codexModel ? p.codexModel : "default",
      approve: p.approve !== false,
    };
  } catch {
    return { max: 3, kind: "claude", model: "opus", codexModel: "default", approve: true };
  }
};

/** Orchestrator mode: a lead Claude chat that splits the task across worker agents. */
export default function OrchestrateModal({
  wsLabel,
  onStart,
  onClose,
}: {
  wsLabel: string;
  onStart: (opts: OrchestrateOpts) => void;
  onClose: () => void;
}) {
  const [opts, setOpts] = useState<OrchestrateOpts>(() => ({ task: "", ...loadPrefs() }));
  const set = (patch: Partial<OrchestrateOpts>) => setOpts((o) => ({ ...o, ...patch }));
  // Codex's own model list (what your account offers), best first.
  const [codexModels, setCodexModels] = useState<{ id: string; label: string }[]>([]);
  useEffect(() => {
    void api("/api/codex-models")
      .then((r) => r.json())
      .then((list) => Array.isArray(list) && setCodexModels(list.slice(0, 3)))
      .catch(() => {});
  }, []);
  const codexChoices = [...codexModels, { id: "default", label: "Default" }];
  const usesClaude = opts.kind !== "codex";
  const usesCodex = opts.kind !== "claude";
  const submit = () => {
    if (!opts.task.trim()) return;
    try {
      localStorage.setItem(PREFS, JSON.stringify({ max: opts.max, kind: opts.kind, model: opts.model, codexModel: opts.codexModel, approve: opts.approve }));
    } catch {
      /* not remembered */
    }
    // A remembered Codex model your account no longer lists: use Codex's default.
    const codexModel = codexChoices.some((m) => m.id === opts.codexModel) ? opts.codexModel : "default";
    onStart({ ...opts, codexModel, task: opts.task.trim() });
  };

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="modal chat-modal orch-modal"
        role="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          // Enter adds lines in the task; ⌘/Ctrl+Enter starts.
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
      >
        <div className="chat-modal-head">
          <span className="chat-modal-icon orch">
            <OrchestrateIcon />
          </span>
          <div>
            <div className="chat-modal-title">Orchestrate</div>
            <div className="chat-modal-sub">A lead Claude splits the task across agents in {wsLabel}</div>
          </div>
        </div>
        <textarea
          className="chat-name-input orch-task"
          value={opts.task}
          placeholder="What should the team do? e.g. Add dark mode to settings, with tests and docs"
          spellCheck={false}
          autoFocus
          onChange={(e) => set({ task: e.target.value })}
        />
        <div className="orch-field">
          <span>Agents</span>
          <div className="orch-seg" role="radiogroup" aria-label="Agents">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" role="radio" aria-checked={opts.max === n} className={opts.max === n ? "on" : ""} onClick={() => set({ max: n })}>
                {n}
              </button>
            ))}
          </div>
        </div>
        <div className="orch-field">
          <span>Workers</span>
          <div className="orch-seg" role="radiogroup" aria-label="Workers">
            {(
              [
                ["claude", <ClaudeLogo key="c" />, "Claude"],
                ["codex", <CodexLogo key="x" />, "Codex"],
                ["mix", null, "Mix"],
              ] as const
            ).map(([kind, icon, label]) => (
              <button key={kind} type="button" role="radio" aria-checked={opts.kind === kind} className={opts.kind === kind ? "on" : ""} onClick={() => set({ kind })}>
                {icon}
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="orch-field">
          {/* The lead is always Claude; this also sets Claude workers' model. */}
          <span title="The lead is always Claude">{!usesCodex ? "Model" : usesClaude ? "Claude" : "Lead"}</span>
          <div className="orch-seg" role="radiogroup" aria-label="Claude model">
            {MODELS.map(([model, label]) => (
              <button
                key={model}
                type="button"
                role="radio"
                aria-checked={opts.model === model}
                className={opts.model === model ? "on" : ""}
                title={model === "default" ? "Whatever your Claude Code is set to" : `Latest ${label}`}
                onClick={() => set({ model })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {usesCodex && (
          <div className="orch-field">
            <span>{usesClaude ? "Codex" : "Workers"}</span>
            <div className="orch-seg" role="radiogroup" aria-label="Codex model">
              {codexChoices.map((m) => {
                const on = opts.codexModel === m.id || (m.id === "default" && !codexChoices.some((c) => c.id === opts.codexModel));
                return (
                  <button
                    key={m.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    className={on ? "on" : ""}
                    title={m.id === "default" ? "Whatever your Codex is set to" : m.id}
                    onClick={() => set({ codexModel: m.id })}
                  >
                    {m.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <label className="orch-check">
          <input type="checkbox" checked={opts.approve} onChange={(e) => set({ approve: e.target.checked })} />
          Show me the plan before agents start
        </label>
        <p className="orch-note">
          Workers open as panes next to the lead. In a git repo each gets its own worktree and branch, and the lead merges them when they're done.
        </p>
        <div className="chat-modal-foot">
          <span className="chat-modal-hint">
            <kbd>{IS_MAC ? "⌘" : "Ctrl"}↵</kbd> start · <kbd>esc</kbd> cancel
          </span>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!opts.task.trim()}>
            Start
          </button>
        </div>
      </form>
    </div>
  );
}
