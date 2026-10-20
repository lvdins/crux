import { useEffect, useRef, useState } from "react";
import type { FlowModule, FlowState, NodeStatus } from "../../types";
import { FLOW_MOCK, getFlows, loadFlows, useFlowVersion } from "../../flow/store";
import { CheckIcon, ChevronDownIcon, ClaudeLogo, CodexLogo, FlowIcon } from "../icons";
import ContextMenu from "../ContextMenu";
import FlowChart from "./FlowChart";
import "./flow.css";

const STATUS_WORD: Record<NodeStatus, string> = { running: "working", ok: "idle", error: "failed", waiting: "waiting" };
// Flows that need you first, then the working ones.
const RANK: Record<NodeStatus, number> = { waiting: 0, error: 1, running: 2, ok: 3 };

const touched = (f: FlowState, id: string) => f.currentModule?.id === id || f.visitedModules.some((m) => m.id === id);

/**
 * Sidebar → Flow: one lane per agent flow (the modules it went through), and
 * a step chart per flow. Opens only when you open it.
 */
export default function FlowView({ wsLabel, onJump }: { wsLabel: (ws?: string) => string; onJump: (term: string) => boolean }) {
  useFlowVersion();
  const [term, setTerm] = useState<string | null>(null);
  const [module, setModule] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    loadFlows()
      .then(() => setError(""))
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setLoaded(true));
  }, []);

  const flows = getFlows();
  const all = new Map<string, FlowModule>();
  for (const f of flows) [...f.visitedModules, ...(f.currentModule ? [f.currentModule] : []), ...f.plannedModules].forEach((m) => all.set(m.id, m));
  const modules = [...all.values()].sort((a, b) => a.label.localeCompare(b.label));
  const open = term ? flows.find((f) => f.term === term) : undefined;
  const shown = flows
    .filter((f) => !module || touched(f, module))
    .sort((a, b) => RANK[a.status] - RANK[b.status] || a.name.localeCompare(b.name));

  const moduleSelect = <ModuleMenu modules={modules} value={module} onChange={setModule} />;

  if (term) {
    return (
      <section className="full-pane flow-pane">
        <FlowChart
          term={term}
          flow={open}
          wsLabel={wsLabel}
          module={module}
          moduleSelect={moduleSelect}
          onBack={() => setTerm(null)}
          onJump={onJump}
        />
      </section>
    );
  }

  return (
    <section className="full-pane flow-pane">
      <div className="flow-head">
        <h2>Flow</h2>
        <span className="flow-sub">What each agent is doing, by module{FLOW_MOCK ? " · mock data" : ""}</span>
        <span className="flow-grow" />
        {moduleSelect}
      </div>
      <div className="flow-lanes">
        {error && <p className="flow-empty">Couldn't load flows: {error}</p>}
        {!error && loaded && shown.length === 0 && (
          <div className="empty-state flow-empty-state">
            <span className="flow-empty-icon">
              <FlowIcon />
            </span>
            <h2>{module ? "Nothing in this module yet" : "No agent activity yet"}</h2>
            <p>{module ? "No flow has touched this module yet." : "Start a Claude chat and its steps show up here."}</p>
          </div>
        )}
        {shown.map((f) => (
          <FlowLane key={f.term} flow={f} wsLabel={wsLabel} focus={module} onOpen={(m) => (setTerm(f.term), m && setModule(m))} />
        ))}
      </div>
    </section>
  );
}

function FlowLane({ flow: f, wsLabel, focus, onOpen }: { flow: FlowState; wsLabel: (ws?: string) => string; focus: string | null; onOpen: (module?: string) => void }) {
  const visited = f.currentModule && !f.visitedModules.some((m) => m.id === f.currentModule!.id) ? [...f.visitedModules, f.currentModule] : f.visitedModules;
  const planned = f.plannedModules.filter((p) => !visited.some((v) => v.id === p.id));
  return (
    <div className={`flow-lane st-${f.status}`} role="button" tabIndex={0} onClick={() => onOpen()} onKeyDown={(e) => e.key === "Enter" && onOpen()} title="Open this flow's steps">
      <div className="flow-lane-head">
        <span className="flow-agent">{f.agent === "codex" ? <CodexLogo /> : <ClaudeLogo />}</span>
        <b className="flow-name">{f.name}</b>
        {f.ws && <span className="kind-tag">{wsLabel(f.ws)}</span>}
        <span className={`flow-status st-${f.status}`}>
          <i />
          {STATUS_WORD[f.status]}
        </span>
      </div>
      <div className="flow-chips">
        {visited.map((m, i) => {
          const now = m.id === f.currentModule?.id;
          return (
            <span key={m.id} className="flow-chip-wrap">
              {i > 0 && <span className="flow-arrow" />}
              <button
                className={`flow-chip ${now ? `now st-${f.status}` : ""} ${focus === m.id ? "focus" : ""}`}
                title={`Only this flow's steps in ${m.label}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpen(m.id);
                }}
              >
                {m.label}
                {now && f.activity && <em>{f.activity}</em>}
              </button>
            </span>
          );
        })}
        {planned.map((m) => (
          <span key={m.id} className="flow-chip-wrap">
            <span className="flow-arrow" />
            <span className="flow-chip planned" title="Announced as next">
              {m.label}
            </span>
          </span>
        ))}
        {!visited.length && <span className="flow-activity">{f.activity || "No module yet"}</span>}
      </div>
    </div>
  );
}

/** Module filter: a button that opens the app's menu (ContextMenu), ✓ on the picked one. */
function ModuleMenu({ modules, value, onChange }: { modules: FlowModule[]; value: string | null; onChange: (id: string | null) => void }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  // The menu closes on pointerdown; don't let that same click reopen it.
  const closedAt = useRef(0);
  const label = modules.find((m) => m.id === value)?.label ?? "All modules";
  const item = (id: string | null, text: string) => ({ label: text, icon: id === value ? <CheckIcon /> : null, onSelect: () => onChange(id) });
  return (
    <>
      <button
        className={`flow-btn flow-pick ${at ? "open" : ""} ${value ? "on" : ""}`}
        title="Only flows and steps in this module"
        aria-haspopup="menu"
        aria-expanded={!!at}
        onClick={(e) => {
          if (at || performance.now() - closedAt.current < 250) return;
          const r = e.currentTarget.getBoundingClientRect();
          // Near the right edge, pass the right side: ContextMenu flips it to end there.
          setAt({ x: r.left + 240 > window.innerWidth - 8 ? r.right : r.left, y: r.bottom + 4 });
        }}
      >
        <span>{label}</span>
        <ChevronDownIcon />
      </button>
      {at && (
        <ContextMenu
          x={at.x}
          y={at.y}
          className="flow-menu"
          groups={[[item(null, "All modules")], ...(modules.length ? [modules.map((m) => item(m.id, m.label))] : [])]}
          onClose={() => {
            closedAt.current = performance.now();
            setAt(null);
          }}
        />
      )}
    </>
  );
}
