import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Background, Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node, type NodeProps, type Viewport } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { FlowState, GraphNode } from "../../types";
import { getGraph, loadGraph, useFlowVersion } from "../../flow/store";
import { ChatIcon, CheckIcon, ChevronLeftIcon, CloseIcon, DocIcon, EditIcon, GlobeIcon, OrchestrateIcon, TerminalIcon, ToolIcon, WaitIcon } from "../icons";
import { BOX_W, buildChart, MAX_BOXES, type Box, type StatusFilter, type TypeFilter } from "../../flow/chart";

type StepData = { box: Box };
type StepNode = Node<StepData, "step">;

const TYPES: [TypeFilter, string, string][] = [
  ["all", "All", "Every step"],
  ["noReads", "No reads", "Hide file reads and searches"],
  ["editsShell", "Edits + shell", "Only edits and shell commands"],
];

const reduceMotion = () => document.documentElement.hasAttribute("data-reduce-motion");

/** One flow's steps: a box per step, newest kept in view while "Follow live" is on. */
export default function FlowChart(props: {
  term: string;
  flow?: FlowState;
  wsLabel: (ws?: string) => string;
  module: string | null;
  moduleSelect: ReactNode;
  onBack: () => void;
  onJump: (term: string) => boolean;
}) {
  return (
    <ReactFlowProvider>
      <Chart {...props} />
    </ReactFlowProvider>
  );
}

function Chart({ term, flow, wsLabel, module, moduleSelect, onBack, onJump }: Parameters<typeof FlowChart>[0]) {
  useFlowVersion();
  const rf = useReactFlow();
  const [type, setType] = useState<TypeFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setError("");
    loadGraph(term).catch((e) => setError(String(e?.message ?? e)));
  }, [term]);

  const g = getGraph(term);
  const chart = useMemo(
    () => (g ? buildChart(g, { module, type, status }, expanded) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [g, g?.rev, module, type, status, expanded],
  );
  const nodes = useMemo<StepNode[]>(
    () => (chart?.boxes ?? []).map((box) => ({ id: box.id, type: "step", position: { x: box.x, y: box.y }, data: { box }, draggable: false, selected: box.id === selected })),
    [chart, selected],
  );
  const edges = useMemo<Edge[]>(
    () =>
      (chart?.edges ?? []).map((e) => ({
        id: e.id,
        source: e.from,
        target: e.to,
        className: `flow-edge ${e.implied ? "implied" : ""} kind-${e.kind}`,
      })),
    [chart],
  );

  // Follow live: keep the newest box in view, near the right edge so the steps before it show too.
  const canvas = useRef<HTMLDivElement>(null);
  const moveFrom = useRef<Viewport | null>(null);
  const last = chart?.boxes[chart.boxes.length - 1];
  const picked = selected ? g?.nodes.get(selected) : undefined;
  // Also re-frames when the details panel opens or closes (the canvas changes width).
  useEffect(() => {
    if (!follow || !last) return;
    const zoom = rf.getZoom();
    const half = (canvas.current?.clientWidth ?? 800) / 2 / zoom;
    const x = Math.max(last.x + BOX_W + 48 / zoom - half, half - 20 / zoom);
    void rf.setCenter(x, last.y + 40, { zoom, duration: reduceMotion() ? 0 : 300 });
  }, [follow, last?.id, last?.x, last?.y, !!picked]); // eslint-disable-line react-hooks/exhaustive-deps

  const total = g?.order.length ?? 0;

  return (
    <>
      <div className="flow-head">
        <button className="flow-btn flow-back" onClick={onBack} title="All flows">
          <ChevronLeftIcon />
          Flows
        </button>
        <h2>{flow?.name ?? term}</h2>
        {flow && (
          <span className="flow-sub">
            {flow.agent}
            {flow.ws ? ` · ${wsLabel(flow.ws)}` : ""} · <span className={`flow-status st-${flow.status}`}><i />{flow.activity || flow.status}</span>
          </span>
        )}
        <span className="flow-grow" />
        <div className="flow-tools">
          {moduleSelect}
          <div className="fm-seg flow-seg" role="radiogroup" aria-label="Step types">
            {TYPES.map(([v, text, tip]) => (
              <button key={v} role="radio" aria-checked={type === v} className={type === v ? "on" : ""} title={tip} onClick={() => setType(v)}>
                {text}
              </button>
            ))}
          </div>
          <label className={`flow-check ${status === "problems" ? "on" : ""}`} title="Only failed steps and steps waiting for you">
            <input type="checkbox" checked={status === "problems"} onChange={(e) => setStatus(e.target.checked ? "problems" : "all")} />
            Errors + waits
          </label>
          {expanded.size > 0 && (
            <button className="flow-btn" onClick={() => setExpanded(new Set())} title="Fold repeated tool calls again">
              Fold repeats
            </button>
          )}
          <label className={`flow-check ${follow ? "on" : ""}`} title="Keep the newest step in view. Panning turns it off.">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
            Follow live
          </label>
        </div>
      </div>
      <div className="flow-body">
        <div className="flow-canvas" ref={canvas}>
          {error && <p className="flow-empty">Couldn't load this flow: {error}</p>}
          {!error && g && !chart?.boxes.length && (
            <div className="empty-state flow-empty-state flow-canvas-empty">
              <h2>{total ? "No matching steps" : "No steps yet"}</h2>
              <p>{total ? "No step matches these filters." : "Steps show up here as the agent works."}</p>
            </div>
          )}
          {!!chart?.hidden && <div className="flow-note">Showing the newest {MAX_BOXES} boxes; {chart.hidden} older hidden.</div>}
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            defaultViewport={{ x: 40, y: 80, zoom: 1 }}
            minZoom={0.2}
            maxZoom={1.6}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable
            // Two-finger scroll pans (like Whimsical); pinch or ⌘ + scroll zooms.
            panOnScroll
            zoomOnPinch
            // Only a real pan / zoom by the user stops following (a click also "starts" a move).
            onMoveStart={(e, vp) => (moveFrom.current = e ? vp : null)}
            onMoveEnd={(e, vp) => {
              const a = moveFrom.current;
              if (e && a && (a.x !== vp.x || a.y !== vp.y || a.zoom !== vp.zoom)) setFollow(false);
            }}
            onNodeClick={(_, n) => {
              const box = (n as StepNode).data.box;
              if (box.members.length > 1) setExpanded((s) => new Set([...s, ...box.members.map((m) => m.id)]));
              else setSelected(box.node.id);
            }}
            onPaneClick={() => setSelected(null)}
          >
            <Background gap={22} size={1} color="var(--line)" />
          </ReactFlow>
        </div>
        {picked && <StepPanel node={picked} term={term} onClose={() => setSelected(null)} onJump={onJump} />}
      </div>
    </>
  );
}

const READ_TOOLS = /^(Read|Glob|Grep|LS|NotebookRead)$/;
const EDIT_TOOLS = /^(Edit|MultiEdit|Write|NotebookEdit|apply_patch)$/;
const SHELL_TOOLS = /^(Bash|shell|exec_command)$/;
const WEB_TOOLS = /^(WebFetch|WebSearch)$|browser/i;

/** Line icon for a step's type (or tool), from the app's icon set. */
function StepIcon({ node }: { node: GraphNode }) {
  const tool = node.meta.tool ?? "";
  const icon =
    node.type === "session" ? <TerminalIcon />
    : node.type === "prompt" ? <ChatIcon />
    : node.type === "subagent" || node.type === "worker" ? <OrchestrateIcon />
    : node.type === "wait" ? <WaitIcon />
    : node.type === "done" ? <CheckIcon />
    : READ_TOOLS.test(tool) ? <DocIcon />
    : EDIT_TOOLS.test(tool) ? <EditIcon />
    : SHELL_TOOLS.test(tool) ? <TerminalIcon />
    : WEB_TOOLS.test(tool) ? <GlobeIcon />
    : <ToolIcon />;
  return <span className="flow-icon">{icon}</span>;
}

const StepBox = memo(function StepBox({ data, selected }: NodeProps<StepNode>) {
  const { box } = data;
  const [more, setMore] = useState(false);
  const n = box.node;
  const folded = box.members.length > 1;
  const label = folded ? `${n.meta.tool} ×${box.members.length}` : n.label;
  return (
    <div className={`flow-box st-${box.status} type-${n.type} ${selected ? "picked" : ""} ${folded ? "folded" : ""}`} style={{ width: BOX_W }}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="flow-box-main" title={folded ? "Click to show each call" : n.label}>
        <StepIcon node={n} />
        <span className="flow-box-label">{label}</span>
      </div>
      <div className="flow-box-meta">
        {n.meta.module && <span className="kind-tag">{n.meta.module.label}</span>}
        {folded ? <span>{n.meta.files?.[0]?.split("/").pop() ?? "repeated calls"}</span> : n.meta.durationMs != null && <span>{fmtMs(n.meta.durationMs)}</span>}
      </div>
      {box.text && (
        <div className={`flow-box-text nodrag nopan ${more ? "open" : ""}`}>
          <p>{box.text}</p>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setMore((m) => !m);
            }}
          >
            {more ? "show less" : "show more"}
          </button>
        </div>
      )}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
});
const NODE_TYPES = { step: StepBox };

const fmtMs = (ms: number) => (ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`);

function StepPanel({ node, term, onClose, onJump }: { node: GraphNode; term: string; onClose: () => void; onJump: (term: string) => boolean }) {
  const [gone, setGone] = useState(false);
  useEffect(() => setGone(false), [node.id]);
  const m = node.meta;
  return (
    <aside className="flow-panel">
      <div className="flow-panel-head">
        <StepIcon node={node} />
        <b>{node.label}</b>
        <button className="flow-x" title="Close" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <dl className="flow-facts">
        <dt>Status</dt>
        <dd>
          <span className={`flow-status st-${node.status}`}>
            <i />
            {node.status}
          </span>
        </dd>
        {m.tool && (
          <>
            <dt>Tool</dt>
            <dd>{m.tool}</dd>
          </>
        )}
        {m.module && (
          <>
            <dt>Module</dt>
            <dd>{m.module.label}</dd>
          </>
        )}
        {m.durationMs != null && (
          <>
            <dt>Duration</dt>
            <dd>{fmtMs(m.durationMs)}</dd>
          </>
        )}
        {!!m.files?.length && (
          <>
            <dt>Files</dt>
            <dd>{m.files.join(", ")}</dd>
          </>
        )}
        {m.url && (
          <>
            <dt>URL</dt>
            <dd>{m.url}</dd>
          </>
        )}
      </dl>
      {m.error && <Block title="Error" body={m.error} error />}
      {m.text && <Block title="Agent said" body={m.text} prose />}
      {m.input && <Block title="Input" body={m.input} />}
      {m.output && <Block title="Output" body={m.output} />}
      <button
        className="primary flow-jump"
        onClick={() => {
          if (!onJump(term)) setGone(true);
        }}
      >
        <TerminalIcon />
        Jump to terminal
      </button>
      {gone && <p className="flow-panel-note">That terminal isn't open any more.</p>}
    </aside>
  );
}

function Block({ title, body, error, prose }: { title: string; body: string; error?: boolean; prose?: boolean }) {
  return (
    <div className="flow-block">
      <div className="flow-block-title">{title}</div>
      <pre className={`${error ? "err" : ""} ${prose ? "prose" : ""}`}>{body}</pre>
    </div>
  );
}
