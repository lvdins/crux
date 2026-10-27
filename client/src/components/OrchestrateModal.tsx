import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../net";
import { IS_MAC } from "../platform";
import { setValue, springValue } from "../spring";
import { ClaudeLogo, CodexLogo } from "./icons";

export interface OrchestrateOpts {
  task: string;
  /** Most workers at once. */
  max: number;
  kind: "claude" | "codex" | "mix";
  /** Claude model alias for a Claude lead and Claude workers; "default" = your Claude setting. */
  model: string;
  /** Codex model for a Codex lead and Codex workers (an id from Codex's model list); "default" = your Codex setting. */
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

/** A pill segmented control whose highlight springs to the chosen option. */
function Seg<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { id: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const glide = useRef<HTMLSpanElement>(null);
  const at = useRef({ x: 0, w: 0 });
  const placed = useRef(false);
  useLayoutEffect(() => {
    const g = glide.current;
    const btn = ref.current?.querySelector<HTMLElement>("button.on");
    if (!g || !btn) return;
    const paint = () => {
      g.style.transform = `translateX(${at.current.x}px)`;
      g.style.width = `${at.current.w}px`;
    };
    const to = { x: btn.offsetLeft, w: btn.offsetWidth };
    for (const k of ["x", "w"] as const) {
      const apply = (v: number) => ((at.current[k] = v), paint());
      if (!placed.current) setValue(g, k, to[k], apply);
      else springValue(g, k, to[k], apply, { response: 0.3, at: at.current[k] });
    }
    placed.current = true;
  }, [value, options.length]);
  return (
    <div className="orch-seg" role="radiogroup" aria-label={label} ref={ref}>
      <span className="orch-seg-glide" ref={glide} />
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          className={value === o.id ? "on" : ""}
          title={o.title}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

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
  // The lead follows the workers: a Codex team has a Codex lead; Claude and Mix a Claude one.
  const usesClaude = opts.kind !== "codex";
  const usesCodex = opts.kind !== "claude";
  const mix = usesClaude && usesCodex;
  // A remembered Codex model your account no longer lists: use Codex's default.
  const codexModel = codexChoices.some((m) => m.id === opts.codexModel) ? opts.codexModel : "default";
  const submit = () => {
    if (!opts.task.trim()) return;
    try {
      localStorage.setItem(PREFS, JSON.stringify({ max: opts.max, kind: opts.kind, model: opts.model, codexModel: opts.codexModel, approve: opts.approve }));
    } catch {
      /* not remembered */
    }
    onStart({ ...opts, codexModel, task: opts.task.trim() });
  };
  // The team at a glance: the lead, then each worker (Mix alternates Claude and Codex).
  const lead = usesClaude ? "claude" : "codex";
  const workers = Array.from({ length: opts.max }, (_, i) => (opts.kind === "mix" ? (i % 2 ? "codex" : "claude") : opts.kind));
  const logo = (k: string) => (k === "claude" ? <ClaudeLogo /> : <CodexLogo />);

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="modal orch-modal"
        role="dialog"
        aria-label="Orchestrate"
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
        <div className="orch-hero">
          <div className="orch-team" aria-hidden>
            <span className={`orch-node lead ${lead}`}>{logo(lead)}</span>
            <span className="orch-workers">
              {workers.map((k, i) => (
                <span key={i} className={`orch-node ${k}`}>
                  {logo(k)}
                </span>
              ))}
            </span>
          </div>
          <h2 className="orch-title">Orchestrate</h2>
          <p className="orch-sub">
            A lead {usesClaude ? "Claude" : "Codex"} splits the task across {opts.max} {opts.max === 1 ? "agent" : "agents"} in <b>{wsLabel}</b>
          </p>
        </div>
        <textarea
          className="orch-task"
          value={opts.task}
          placeholder="What should the team build?"
          spellCheck={false}
          autoFocus
          rows={3}
          onChange={(e) => set({ task: e.target.value })}
        />
        <div className="orch-grid">
          <span className="orch-label">Agents</span>
          <Seg label="Agents" value={opts.max} options={[1, 2, 3, 4, 5].map((n) => ({ id: n, label: n }))} onChange={(max) => set({ max })} />
          <span className="orch-label">Workers</span>
          <Seg
            label="Workers"
            value={opts.kind}
            options={[
              { id: "claude" as const, label: <><ClaudeLogo />Claude</> },
              { id: "codex" as const, label: <><CodexLogo />Codex</> },
              { id: "mix" as const, label: "Mix" },
            ]}
            onChange={(kind) => set({ kind })}
          />
          {usesClaude && (
            <>
              <span className="orch-label" title={mix ? "The lead and Claude workers" : undefined}>
                {mix ? "Claude" : "Model"}
              </span>
              <Seg
                label="Claude model"
                value={opts.model}
                options={MODELS.map(([id, label]) => ({ id, label, title: id === "default" ? "Whatever your Claude Code is set to" : `Latest ${label}` }))}
                onChange={(model) => set({ model })}
              />
            </>
          )}
          {usesCodex && (
            <>
              <span className="orch-label" title={mix ? "Codex workers" : undefined}>
                {mix ? "Codex" : "Model"}
              </span>
              <Seg
                label="Codex model"
                value={codexModel}
                options={codexChoices.map((m) => ({ id: m.id, label: m.label, title: m.id === "default" ? "Whatever your Codex is set to" : m.id }))}
                onChange={(id) => set({ codexModel: id })}
              />
            </>
          )}
        </div>
        <label className="orch-approve">
          <span className="orch-approve-text">
            <b>Review the plan first</b>
            <span>The lead shows how it splits the work and waits for your OK</span>
          </span>
          <input type="checkbox" className="settings-switch" checked={opts.approve} onChange={(e) => set({ approve: e.target.checked })} />
        </label>
        <p className="orch-note">Each worker gets its own pane, worktree and branch. The lead merges them when they're done.</p>
        <div className="orch-foot">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!opts.task.trim()}>
            Start team <kbd>{IS_MAC ? "⌘" : "Ctrl"}↵</kbd>
          </button>
        </div>
      </form>
    </div>
  );
}
