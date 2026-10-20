import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../net";

/**
 * Write guard controls under the browser bar. The page script
 * (netRecorder.js) answers non-GET requests to lab / preview hosts itself
 * unless the QA round's intake.md grants their write class; this pushes the
 * policy into every pane (guard_set), asks about "ask each time" writes,
 * and sends guarded writes to the server's log, which flags leaks.
 * One guard for all panes, so its state lives in this module.
 */

export interface GuardReply {
  status: number;
  delay: number;
}
export interface GuardLeak {
  method: string;
  url: string;
  cls: string | null;
  restore?: string;
}
interface GuardState {
  enabled: boolean;
  on: boolean;
  round: string;
  reply: GuardReply;
  hosts: string[];
  rounds: string[];
  problem: string;
}

const STATUSES = [200, 400, 403, 404, 409, 422, 500, 503];
const SLOW_MS = 3000;

async function invoke<T = void>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(cmd, args);
}

const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem("crux.guard") ?? "{}");
  } catch {
    return {};
  }
})();
let state: GuardState = {
  enabled: false,
  on: !!saved.on,
  round: typeof saved.round === "string" ? saved.round : "",
  reply: { status: Number(saved.reply?.status) || 200, delay: Number(saved.reply?.delay) || 0 },
  hosts: [],
  rounds: [],
  problem: "",
};
const listeners = new Set<() => void>();
let pushSeq = 0;

function set(patch: Partial<GuardState>, push = true) {
  state = { ...state, ...patch };
  try {
    localStorage.setItem("crux.guard", JSON.stringify({ on: state.on, round: state.round, reply: state.reply }));
  } catch {
    /* private storage */
  }
  listeners.forEach((l) => l());
  if (push) void pushPolicy();
}

/** Fetch the round's policy and hand it to every browser pane. */
async function pushPolicy() {
  const seq = ++pushSeq;
  const on = state.enabled && state.on;
  try {
    const policy = on
      ? await api(`/api/guard/policy?round=${encodeURIComponent(state.round)}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error("no policy"))))
      : {};
    if (seq !== pushSeq) return;
    if (on) set({ hosts: policy.hosts ?? [], problem: "" }, false);
    await invoke("guard_set", { policy: { ...policy, on }, reply: state.reply });
  } catch (err) {
    if (seq !== pushSeq) return;
    set({ problem: String((err as Error)?.message ?? err) }, false);
    // No policy (server down, bad round): block every guarded write rather than none.
    if (on) {
      const hosts = state.hosts.length ? state.hosts : ["lab", "vercel.app", "preview"];
      await invoke("guard_set", { policy: { on, hosts, rules: [] }, reply: state.reply }).catch(() => undefined);
    }
  }
}

export const guardStore = {
  get: () => state,
  subscribe: (l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  set,
  /** Settings → Tabs & views → Write guard. Off: pages are never guarded. */
  enable: (enabled: boolean) => {
    if (enabled === state.enabled) return;
    set({ enabled });
    if (enabled) void api("/api/guard/rounds").then((r) => r.json()).then((d) => set({ rounds: d.rounds ?? [] }, false)).catch(() => undefined);
  },
  /** The policy again (the round's intake.md may have new grants). */
  refresh: () => void pushPolicy(),
};

export const useGuard = () => useSyncExternalStore(guardStore.subscribe, guardStore.get);

interface Row {
  id: number;
  type: string;
  method: string;
  url: string;
  start: number;
  status: number;
  reqBody: string | null;
  guarded?: boolean;
  blocked?: boolean;
  class?: string | null;
  grant?: string | null;
  ask?: "pending" | "allowed" | "blocked";
}

/** Polls the active pane while the guard is on: asks, and the server log. */
export function useGuardWatch(label: string, ws: string, active: boolean, onLeak: (leak: GuardLeak) => void) {
  const g = useGuard();
  const [asks, setAsks] = useState<Row[]>([]);
  const [blocked, setBlocked] = useState(0);
  const leakRef = useRef(onLeak);
  leakRef.current = onLeak;
  const on = g.enabled && g.on && active;

  useEffect(() => {
    setAsks([]);
    if (!on) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const s = { page: "", since: 0, rows: new Map<number, Row>(), sent: new Set<number>() };
    const poll = async () => {
      try {
        const raw = await invoke<string>("browser_js", { label, script: `return window.__qlNet ? window.__qlNet.take(${s.since}) : "null";`, pageWorld: true });
        const data = JSON.parse(raw) as { page: string; version: number; entries: Row[] } | null;
        if (data) {
          if (data.page !== s.page) {
            s.page = data.page;
            s.rows = new Map();
            s.sent = new Set();
          }
          for (const e of data.entries) if (e.guarded) s.rows.set(e.id, e);
          s.since = data.version;
          const rows = [...s.rows.values()];
          setAsks(rows.filter((e) => e.ask === "pending"));
          setBlocked(rows.filter((e) => e.blocked).length);
          // Done rows only (answered, or an ask that was settled).
          const ready = rows.filter((e) => !s.sent.has(e.id) && e.ask !== "pending" && (e.blocked || e.status !== 0 || e.type === "form"));
          if (ready.length) {
            ready.forEach((e) => s.sent.add(e.id));
            const res = await api("/api/guard/log", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ws, round: guardStore.get().round, entries: ready.map((e) => ({ ...e, page: data.page })) }),
            });
            const out = res.ok ? await res.json() : { leaks: [] };
            for (const leak of out.leaks ?? []) leakRef.current(leak);
          }
        }
      } catch {
        /* no page yet */
      }
      if (!stopped) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [on, label, ws, g.round]);

  const answer = (id: number, ok: boolean) => {
    setAsks((a) => a.filter((e) => e.id !== id));
    void invoke("browser_js", { label, script: `return window.__qlNet ? window.__qlNet.answer(${id}, ${ok}) : "gone";`, pageWorld: true }).catch(() => undefined);
  };
  return { asks, blocked, answer };
}

const shortUrl = (u: string) => {
  try {
    const x = new URL(u);
    return x.host + x.pathname;
  } catch {
    return u;
  }
};

/** The bar under the address bar while the guard is on. */
export function GuardBar({ asks, blocked, answer, leak }: ReturnType<typeof useGuardWatch> & { leak?: GuardLeak | null }) {
  const g = useGuard();
  const [hosts, setHosts] = useState("");
  useEffect(() => setHosts(g.hosts.join(", ")), [g.hosts]);
  if (!g.enabled || !g.on) return null;
  const saveHosts = () => {
    const list = hosts.split(/[\s,]+/).filter(Boolean);
    if (list.join(",") === g.hosts.join(",")) return;
    void api("/api/guard/hosts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hosts: list }) }).then(() => guardStore.refresh());
  };
  return (
    <div className="guard-bar">
      <div className="guard-row">
        <b className="guard-title">Write guard</b>
        <label title="QA round whose intake.md grants write classes (none: every write is answered here)">
          Round
          <select value={g.round} onChange={(e) => guardStore.set({ round: e.target.value })}>
            <option value="">none (block all)</option>
            {[...new Set([g.round, ...g.rounds].filter(Boolean))].map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label title="What a blocked write gets back">
          Reply
          <select value={g.reply.status} onChange={(e) => guardStore.set({ reply: { ...g.reply, status: Number(e.target.value) } })}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s === 200 ? "200 echo body" : s}
              </option>
            ))}
          </select>
        </label>
        <label title={`Answer after ${SLOW_MS / 1000} s`}>
          <input type="checkbox" checked={g.reply.delay > 0} onChange={(e) => guardStore.set({ reply: { ...g.reply, delay: e.target.checked ? SLOW_MS : 0 } })} />
          slow
        </label>
        <label className="guard-hosts" title="Writes to hosts containing any of these are guarded">
          Hosts
          <input value={hosts} spellCheck={false} onChange={(e) => setHosts(e.target.value)} onBlur={saveHosts} onKeyDown={(e) => e.key === "Enter" && saveHosts()} />
        </label>
        <button onClick={guardStore.refresh} title="Read the round's intake.md again">
          ↻
        </button>
        <span className="guard-count">{blocked} blocked</span>
      </div>
      {g.problem && <div className="guard-problem">Guard policy: {g.problem}</div>}
      {asks.map((a) => (
        <div key={a.id} className="guard-ask">
          <span>
            <b>{a.method}</b> {shortUrl(a.url)} <small>{a.class}</small>
          </span>
          <button onClick={() => answer(a.id, true)}>Allow</button>
          <button onClick={() => answer(a.id, false)}>Block</button>
        </div>
      ))}
      {leak && <LeakBanner leak={leak} />}
    </div>
  );
}

export function LeakBanner({ leak, onClose }: { leak: GuardLeak; onClose?: () => void }) {
  return (
    <div className="guard-leak" role="alert">
      <span>
        Write reached the server outside a grant: <b>{leak.method}</b> <code>{leak.url}</code>
        {leak.cls && <small> ({leak.cls})</small>}
        {leak.restore && <span className="guard-restore">Restore: {leak.restore}</span>}
      </span>
      {onClose && (
        <button onClick={onClose} title="Dismiss">
          ×
        </button>
      )}
    </div>
  );
}
