import { useCallback, useEffect, useState } from "react";
import { api } from "../net";

/**
 * QA run panel: one qa-skills 2.0.0 round (qa-full-pass / qa-lite) read from
 * its folder: the five batches with their gates (the skill's check_round.py),
 * the pause after Batch 2, the lanes, locks, worktrees and timings. Crux never
 * writes into the round; Go and re-runs go to the coordinator's chat.
 */

/** Window event carrying the server's qa:* messages (App.tsx). */
export const QA_EVENT = "crux:qa";

interface GateLine {
  text: string;
  open: boolean;
}
interface Gate {
  batch?: number;
  lane?: string;
  ran: boolean;
  ok: boolean;
  code: number | null;
  lines: GateLine[];
  error?: string;
  at: string;
}
interface Batch {
  n: number;
  name: string;
  status: "pending" | "running" | "paused" | "done" | "failed";
  block: string;
  gate?: Gate;
}
interface Lane {
  name: string;
  status: string;
  cases?: number;
  pass?: number;
  fail?: number;
  blocked?: number;
  not_tested?: number;
  reason?: string;
}
interface Area {
  area: string;
  cases: { id?: string; title: string }[];
}
interface Skills {
  dir: string;
  version: string;
  check: boolean;
  lite: boolean;
}
interface Round {
  target: string;
  n: number;
  dir: string;
  exists: boolean;
  tier: string;
  stale: string[];
  writeClasses: { name: string; granted: boolean; limits: string }[];
  batches: Batch[];
  current: number;
  gate: Gate | null;
  lanes: Lane[];
  pause: { after: number; cases: Area[] } | null;
  cases: Area[];
  findings: { id: string; title: string; severity?: string; status?: string }[];
  report: { findings: number; url?: string } | null;
  timings: { wall?: number; active?: number; pause?: number } | null;
  locks: { name: string; holder: string; at: string }[];
  worktrees: string[];
  skills?: Skills;
  coordinator?: string | null;
}
interface RoundList {
  root: string;
  exists: boolean;
  skills: Skills;
  targets: { target: string; rounds: number[] }[];
}

const TONE: Record<Batch["status"], string> = { done: "ok", failed: "bad", running: "run", paused: "run", pending: "off" };
const LANE_TONE = (s: string) => (/done/.test(s) ? "ok" : /fail|block/.test(s) ? "bad" : /run|partial/.test(s) ? "run" : "off");
const dur = (sec?: number) => {
  if (sec == null) return "–";
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};
const mrOf = (target: string) => /\d{2,7}/.exec(target)?.[0] ?? "";
const OPEN_FINDING = /closed|verified|won.?t|invalid|duplicate|not a bug/i;

async function json<T>(r: Response): Promise<T> {
  if (!(r.headers.get("content-type") ?? "").includes("json")) throw new Error("Crux's server is older than this window. Restart Crux");
  const body = await r.json();
  if (!r.ok) throw new Error(body.error ?? r.statusText);
  return body;
}
const post = (path: string, body: unknown) =>
  api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => json<any>(r));

function GateView({ gate }: { gate?: Gate }) {
  if (!gate) return null;
  if (!gate.ran) return <div className="qa-gate-out bad">{gate.error}</div>;
  return (
    <pre className="qa-gate-out">
      {gate.lines.map((l, i) => (
        <div key={i} className={l.open ? "open" : ""}>
          {l.text}
        </div>
      ))}
      {!gate.lines.length && <div>(no output) exit {gate.code}</div>}
    </pre>
  );
}

function GateBadge({ gate }: { gate?: Gate }) {
  if (!gate) return <span className="qa-badge off">not checked</span>;
  if (!gate.ran) return <span className="qa-badge bad" title={gate.error}>can't check</span>;
  const open = gate.lines.filter((l) => l.open).length;
  return gate.ok ? <span className="qa-badge ok">gate passed</span> : <span className="qa-badge bad">gate open{open ? ` · ${open}` : ""}</span>;
}

export default function QaPanel({ wsKey, qaRoot, onRoot }: { wsKey: string; qaRoot: string; onRoot: (root: string) => void }) {
  const [list, setList] = useState<RoundList | null>(null);
  const [pick, setPick] = useState<{ target: string; n: number } | null>(null);
  const [round, setRound] = useState<Round | null>(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [laneGates, setLaneGates] = useState<Record<string, Gate>>({});
  const [checking, setChecking] = useState("");
  const [note, setNote] = useState("");
  const [form, setForm] = useState({ mr: "", skill: "qa-full-pass", mode: "full" });
  const [starting, setStarting] = useState(false);
  const [root, setRoot] = useState(qaRoot);
  useEffect(() => setRoot(qaRoot), [qaRoot]);

  const loadList = useCallback(() => {
    api("/api/qa/rounds")
      .then((r) => json<RoundList>(r))
      .then((l) => {
        setList(l);
        setError("");
        // First load (or the picked round is gone): newest round of the first target.
        setPick((p) => (p && l.targets.some((t) => t.target === p.target && t.rounds.includes(p.n)) ? p : l.targets[0]?.rounds[0] ? { target: l.targets[0].target, n: l.targets[0].rounds[0] } : null));
      })
      .catch((err) => setError(String(err.message ?? err)));
  }, []);
  useEffect(() => {
    loadList();
    // New round folders appear while a coordinator runs.
    const t = setInterval(loadList, 15_000);
    return () => clearInterval(t);
  }, [loadList, qaRoot]);

  const loadRound = useCallback(() => {
    if (!pick) return setRound(null);
    api(`/api/qa/rounds/${encodeURIComponent(pick.target)}/${pick.n}`)
      .then((r) => json<Round>(r))
      .then((r) => {
        setRound(r);
        setForm((f) => (f.mr ? f : { ...f, mr: mrOf(r.target) }));
      })
      .catch((err) => setError(String(err.message ?? err)));
  }, [pick]);
  useEffect(() => {
    setLaneGates({});
    setOpen(null);
    loadRound();
  }, [loadRound]);

  // Live: the server watches the open round and sends it whole on each change.
  useEffect(() => {
    const on = (e: Event) => {
      const m = (e as CustomEvent).detail;
      if (m?.type === "qa:round" && pick && m.target === pick.target && m.n === pick.n) {
        setRound((prev) => ({ ...m, skills: prev?.skills, coordinator: prev?.coordinator }));
      }
    };
    window.addEventListener(QA_EVENT, on);
    return () => window.removeEventListener(QA_EVENT, on);
  }, [pick]);

  const check = (what: { batch?: number; lane?: string }) => {
    if (!round) return;
    const key = what.lane ? `l:${what.lane}` : `b:${what.batch}`;
    setChecking(key);
    api(`/api/qa/rounds/${encodeURIComponent(round.target)}/${round.n}/check?${what.lane ? `lane=${encodeURIComponent(what.lane)}` : `batch=${what.batch}`}`)
      .then((r) => json<Gate>(r))
      .then((g) => {
        if (what.lane) setLaneGates((prev) => ({ ...prev, [what.lane!]: g }));
        else setRound((r) => (r ? { ...r, batches: r.batches.map((b) => (b.n === what.batch ? { ...b, gate: g } : b)) } : r));
      })
      .catch((err) => setMsg(String(err.message ?? err)))
      .finally(() => setChecking(""));
  };

  const start = (body: Record<string, unknown>) => {
    setStarting(true);
    setMsg("");
    post("/api/qa/start", { ws: wsKey, ...body })
      .then((r) => setMsg(`Started in a new chat: ${r.task}`))
      .catch((err) => setMsg(String(err.message ?? err)))
      .finally(() => setStarting(false));
  };

  const go = (action: "go" | "changes") => {
    if (!round) return;
    post("/api/qa/go", { target: round.target, n: round.n, note, action })
      .then(() => {
        setMsg(action === "go" ? "Go sent to the coordinator's chat." : "Changes sent to the coordinator's chat.");
        setNote("");
      })
      .catch((err) => setMsg(String(err.message ?? err)));
  };

  const skills = round?.skills ?? list?.skills;
  const mr = form.mr.trim();
  const openFindings = round?.findings.filter((f) => !OPEN_FINDING.test(f.status ?? "")) ?? [];

  return (
    <div className="qa">
      <div className="qa-head">
        <select
          value={pick ? `${pick.target}/${pick.n}` : ""}
          onChange={(e) => {
            const [target, n] = e.target.value.split("/");
            setPick({ target, n: Number(n) });
          }}
        >
          {!list?.targets.length && <option value="">No rounds yet</option>}
          {list?.targets.map((t) => (
            <optgroup key={t.target} label={t.target}>
              {t.rounds.map((n) => (
                <option key={n} value={`${t.target}/${n}`}>
                  {t.target} · round {n}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <span className={`qa-tag ${skills?.check ? "" : "bad"}`} title={skills?.dir}>
          {skills ? (skills.version ? `qa-skills ${skills.version}` : skills.check ? "qa-skills" : "qa-skills not installed") : "…"}
        </span>
        <button
          onClick={() => {
            loadList();
            loadRound();
          }}
          title="Refresh"
        >
          ↻
        </button>
      </div>

      <div className="qa-body">
        {error && <div className="pipes-error">{error}</div>}
        {msg && (
          <div className="qa-msg" onClick={() => setMsg("")}>
            {msg}
          </div>
        )}
        {list && !list.exists && (
          <div className="pipes-empty">
            No QA folder at <code>{list.root}</code> yet. Start a round below; qa-full-pass creates it.
          </div>
        )}
        {round && (
          <>
            <div className="qa-summary">
              {round.tier && <span className="qa-tag">{round.tier}</span>}
              <code title={round.dir}>{round.dir}</code>
              {round.report?.url && (
                <a href={round.report.url} target="_blank" rel="noreferrer">
                  Report ↗
                </a>
              )}
            </div>

            {round.pause && (
              <div className="qa-pause">
                <div className="qa-pause-top">
                  <b>Paused after Batch {round.pause.after}</b>
                  <span>Review the cases. The round continues only on your Go.</span>
                </div>
                {round.pause.cases.map((a) => (
                  <div key={a.area} className="qa-area">
                    <div className="qa-area-name">
                      {a.area} <small>{a.cases.length}</small>
                    </div>
                    <ul>
                      {a.cases.map((c, i) => (
                        <li key={c.id ?? i}>
                          {c.id && <code>{c.id}</code>} {c.title}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
                {!round.pause.cases.length && <div className="pipes-empty">cases.md is empty or missing.</div>}
                <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={4000} placeholder="Changes to the cases (optional): add, drop or reword…" />
                <div className="qa-actions">
                  <button className="qa-primary" onClick={() => go("go")}>
                    Go
                  </button>
                  <button onClick={() => go("changes")} disabled={!note.trim()}>
                    Send changes
                  </button>
                  {!round.coordinator && <small>Not started from Crux: Go needs the coordinator's chat.</small>}
                </div>
              </div>
            )}

            <div className="qa-batches">
              {round.batches.map((b) => {
                const expanded = open === b.n;
                return (
                  <div key={b.n} className={`qa-batch ${b.n === round.current ? "current" : ""}`}>
                    <div className="qa-batch-top" onClick={() => setOpen(expanded ? null : b.n)}>
                      <span className={`pipe-dot ${TONE[b.status]}`} />
                      <b>
                        {b.n}. {b.name}
                      </b>
                      <span className="qa-status">{b.status}</span>
                      <GateBadge gate={b.gate} />
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          check({ batch: b.n });
                        }}
                        disabled={!!checking}
                        title={`check_round.py --batch ${b.n}`}
                      >
                        {checking === `b:${b.n}` ? "…" : "Check"}
                      </button>
                    </div>
                    {b.gate && !b.gate.ok && !expanded && <GateView gate={{ ...b.gate, lines: b.gate.lines.filter((l) => l.open) }} />}
                    {expanded && (
                      <>
                        <GateView gate={b.gate} />
                        {b.block ? <pre className="qa-block">{b.block}</pre> : <div className="pipes-empty">No status block in run-log.md yet.</div>}
                        {b.n === 1 && (round.writeClasses.length > 0 || round.stale.length > 0) && (
                          <div className="qa-intake">
                            {round.writeClasses.length > 0 && (
                              <table>
                                <thead>
                                  <tr>
                                    <th>Write class</th>
                                    <th>Granted</th>
                                    <th>Limits</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {round.writeClasses.map((w) => (
                                    <tr key={w.name}>
                                      <td>{w.name}</td>
                                      <td className={w.granted ? "ok" : ""}>{w.granted ? "yes" : "no"}</td>
                                      <td>{w.limits}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                            {round.stale.length > 0 && (
                              <div>
                                <small>Stale facts</small>
                                <ul>
                                  {round.stale.map((s, i) => (
                                    <li key={i}>{s}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>

            {round.lanes.length > 0 && (
              <table className="qa-lanes">
                <thead>
                  <tr>
                    <th>Lane</th>
                    <th>Status</th>
                    <th title="cases · pass / fail / blocked / not tested">Cases</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {round.lanes.map((l) => (
                    <tr key={l.name}>
                      <td>
                        <span className={`pipe-dot ${LANE_TONE(l.status)}`} /> {l.name}
                      </td>
                      <td>
                        {l.status}
                        {l.reason && <small> · {l.reason}</small>}
                        {laneGates[l.name] && <GateView gate={laneGates[l.name]} />}
                      </td>
                      <td className="qa-num">
                        {l.cases != null ? (
                          <>
                            {l.cases} · {l.pass ?? 0}/<em>{l.fail ?? 0}</em>/{l.blocked ?? 0}/{l.not_tested ?? 0}
                          </>
                        ) : (
                          "–"
                        )}
                      </td>
                      <td>
                        <button onClick={() => check({ lane: l.name })} disabled={!!checking} title={`check_round.py --lane ${l.name}`}>
                          {checking === `l:${l.name}` ? "…" : laneGates[l.name] ? (laneGates[l.name].ok ? "✓" : "✗") : "Check"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <div className="qa-actions">
              <button disabled={starting || !mr} onClick={() => start({ mr, skill: form.skill, mode: "full", target: round.target, n: round.n })} title="New round; the command lists this round's findings from findings.md">
                Re-run as round {round.n + 1}
              </button>
              <button disabled={starting || !mr || !openFindings.length} onClick={() => start({ mr, skill: form.skill, mode: "retest", target: round.target, n: round.n })}>
                Re-test fixes only ({openFindings.length})
              </button>
            </div>

            <div className="qa-footer">
              <div>
                <small>Timings</small> wall {dur(round.timings?.wall)} · active {dur(round.timings?.active)} · pause {dur(round.timings?.pause)}
              </div>
              <div>
                <small>Locks</small>{" "}
                {round.locks.length
                  ? round.locks.map((l) => (
                      <span key={l.name} className="qa-tag" title={`${l.holder} · ${new Date(l.at).toLocaleString()}`}>
                        {l.name}
                      </span>
                    ))
                  : "none"}
              </div>
              <div>
                <small>Worktrees</small> {round.worktrees.length ? round.worktrees.join(", ") : "none"}
              </div>
              {round.report && (
                <div>
                  <small>Report</small> {round.report.findings} findings published
                </div>
              )}
            </div>
          </>
        )}

        <form
          className="qa-start"
          onSubmit={(e) => {
            e.preventDefault();
            if (mr) start({ mr, skill: form.skill, mode: form.mode });
          }}
        >
          <div className="qa-start-title">Start QA round</div>
          <div className="qa-start-row">
            <input value={form.mr} onChange={(e) => setForm({ ...form, mr: e.target.value.replace(/[^\w!-]/g, "") })} placeholder="MR iid (5265) or ticket" maxLength={20} />
            <select value={form.skill} onChange={(e) => setForm({ ...form, skill: e.target.value })}>
              <option value="qa-full-pass">qa-full-pass</option>
              <option value="qa-lite">qa-lite</option>
            </select>
            <select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
              <option value="full">Full round</option>
              <option value="plan-only">Plan only</option>
              <option value="recheck">Re-check gates</option>
              <option value="retest">Re-test</option>
            </select>
            <button type="submit" className="qa-primary" disabled={starting || !mr}>
              Start
            </button>
          </div>
          <small>qa-lite fits small MRs: up to 15 files and 1,200 changed lines, with no Deep change type.</small>
        </form>

        <div className="qa-root">
          <small>QA folder</small>
          <input
            value={root}
            onChange={(e) => setRoot(e.target.value)}
            onBlur={() => root.trim() !== qaRoot && onRoot(root.trim())}
            placeholder={list?.root ?? "~/qa-runs"}
            maxLength={300}
          />
        </div>
      </div>
    </div>
  );
}
