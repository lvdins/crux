import { useCallback, useEffect, useState } from "react";
import { api } from "../net";

export interface PipelineRun {
  id: number;
  status: string;
  createdAt: string;
  updatedAt: string;
  webUrl: string;
  duration?: number | null;
  tests?: { count: number; success: number; failed: number; skipped: number; error: number };
  failedJobs?: { name: string; stage: string; webUrl: string }[];
  failedTests?: { name: string; suite: string }[];
}
export interface Schedule {
  id: number;
  description: string;
  cron: string;
  timezone: string;
  active: boolean;
  nextRunAt: string | null;
  runs: PipelineRun[];
}
export interface PipelineInfo {
  host: string;
  project: string;
  webUrl: string;
  schedules: Schedule[];
  fetchedAt: string;
}

const STATUS: Record<string, { label: string; tone: string }> = {
  success: { label: "Passed", tone: "ok" },
  failed: { label: "Failed", tone: "bad" },
  running: { label: "Running", tone: "run" },
  pending: { label: "Pending", tone: "run" },
  created: { label: "Queued", tone: "run" },
  canceled: { label: "Canceled", tone: "off" },
  skipped: { label: "Skipped", tone: "off" },
  manual: { label: "Manual", tone: "off" },
};
const statusOf = (s: string) => STATUS[s] ?? { label: s, tone: "off" };

/** "0 6 * * 1-5" → "06:00 Mon–Fri". */
function cronLabel(cron: string): string {
  const [m, h, , , dow] = cron.split(/\s+/);
  const time = /^\d+$/.test(h) && /^\d+$/.test(m) ? `${h.padStart(2, "0")}:${m.padStart(2, "0")}` : cron;
  const days = dow === "1-5" ? "Mon–Fri" : dow === "*" ? "daily" : dow;
  return `${time} ${days}`;
}

const ago = (iso: string) => {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 36 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};
const mins = (sec?: number | null) => (sec ? `${Math.round(sec / 60)} min` : "");

/** Latest-run status across a workspace's active schedules (sidebar dot). */
export function overallTone(info: PipelineInfo | null): "ok" | "bad" | "run" | null {
  if (!info) return null;
  const latest = info.schedules.filter((s) => s.active && s.runs[0]).map((s) => statusOf(s.runs[0].status).tone);
  if (!latest.length) return null;
  if (latest.includes("bad")) return "bad";
  if (latest.includes("run")) return "run";
  return "ok";
}

/** "Check errors" prompt for one schedule's latest run. */
export function checkPrompt(info: PipelineInfo, s: Schedule): string {
  const r = s.runs[0];
  const lines = [
    `Check the "${s.description}" pipeline run and return its errors: for each failed job or test, the error message and the likely cause. Don't change any code.`,
    "",
    `Run: #${r.id} (${r.status}, ${r.createdAt}) ${r.webUrl}`,
    `Read a job's log with: glab ci trace <job name> --pipeline-id ${r.id} -R https://${info.host}/${info.project}`,
  ];
  if (r.tests) lines.push(`Tests: ${r.tests.success}/${r.tests.count} passed, ${r.tests.failed} failed, ${r.tests.error} errors`);
  if (r.failedJobs?.length) lines.push(`Failed jobs: ${r.failedJobs.map((j) => `${j.name} (${j.webUrl})`).join(", ")}`);
  if (r.failedTests?.length) lines.push(`Failed tests: ${r.failedTests.map((t) => `${t.suite} › ${t.name}`).join("; ")}`);
  return lines.join("\n");
}

/** Pipelines tab: morning / evening scheduled runs; "Check errors" asks the agent. */
export default function PipelinesPanel({
  wsKey,
  onInfo,
  onCheck,
}: {
  wsKey: string;
  onInfo?: (info: PipelineInfo | null) => void;
  /** Send the prompt to the workspace's agent. */
  onCheck: (prompt: string) => void;
}) {
  const [info, setInfo] = useState<PipelineInfo | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<number | null>(null);

  const load = useCallback(
    (refresh = false) => {
      setLoading(true);
      api(`/api/pipelines/${wsKey}${refresh ? "?refresh=1" : ""}`)
        .then(async (r) => {
          // A server from before this tab existed answers with an HTML 404.
          if (!(r.headers.get("content-type") ?? "").includes("json")) {
            throw new Error("Crux's server is older than this window. Restart Crux");
          }
          const body = await r.json();
          if (!r.ok) throw new Error(body.error ?? r.statusText);
          setInfo(body);
          setError("");
          onInfo?.(body);
        })
        .catch((err) => setError(String(err.message ?? err)))
        .finally(() => setLoading(false));
    },
    [wsKey, onInfo],
  );
  useEffect(() => load(), [load]);

  return (
    <div className="pipes">
      <div className="pipes-head">
        <span>{info ? info.project : "Scheduled pipelines"}</span>
        {info && (
          <a href={`${info.webUrl}/-/pipeline_schedules`} target="_blank" rel="noreferrer">
            GitLab ↗
          </a>
        )}
        <button onClick={() => load(true)} disabled={loading} title="Refresh">
          {loading ? "…" : "↻"}
        </button>
      </div>

      <div className="pipes-list">
        {error && (
          <div className="pipes-error">
            Couldn't load pipelines: {error}.
            {!/restart crux/i.test(error) && (
              <>
                {" "}Is <code>glab</code> logged in to this GitLab?
              </>
            )}
          </div>
        )}
        {!error && !info && <div className="pipes-empty">Loading…</div>}
        {info && info.schedules.length === 0 && <div className="pipes-empty">No scheduled pipelines in this project.</div>}
        {info?.schedules.map((s) => {
          const r = s.runs[0];
          const st = r ? statusOf(r.status) : null;
          const expanded = open === s.id;
          const failures = (r?.failedTests?.length ?? 0) + (r?.failedJobs?.length ?? 0);
          return (
            <div key={s.id} className={`pipe-card ${st?.tone ?? "off"} ${s.active ? "" : "inactive"}`}>
              <div className="pipe-top">
                <span className={`pipe-dot ${st?.tone ?? "off"}`} />
                <b>{s.description}</b>
                <span className="pipe-when">{cronLabel(s.cron)}</span>
                {!s.active && <span className="pipe-tag">paused</span>}
              </div>
              {r ? (
                <>
                  <div className="pipe-line">
                    <a href={r.webUrl} target="_blank" rel="noreferrer" className={`pipe-status ${st!.tone}`}>
                      {st!.label}
                    </a>
                    <span>{ago(r.createdAt)}</span>
                    {r.duration ? <span>· {mins(r.duration)}</span> : null}
                    {r.tests && (
                      <span className="pipe-tests">
                        · {r.tests.success}/{r.tests.count} passed
                        {r.tests.failed + r.tests.error > 0 && <em> · {r.tests.failed + r.tests.error} failing</em>}
                      </span>
                    )}
                  </div>
                  <div className="pipe-history" title="Last runs, newest first">
                    {s.runs.map((x) => (
                      <a key={x.id} href={x.webUrl} target="_blank" rel="noreferrer" className={`pipe-tick ${statusOf(x.status).tone}`} title={`${statusOf(x.status).label} · ${new Date(x.createdAt).toLocaleString()}`} />
                    ))}
                  </div>
                  <div className="pipe-actions">
                    {failures > 0 && (
                      <button className="pipe-more" onClick={() => setOpen(expanded ? null : s.id)}>
                        {expanded ? "Hide" : "Show"} what failed ({failures})
                      </button>
                    )}
                    <button className="pipe-check" onClick={() => onCheck(checkPrompt(info!, s))} title="Ask the agent to read this run's logs and list the errors">
                      Check errors
                    </button>
                  </div>
                  {expanded && (
                    <ul className="pipe-fails">
                      {r.failedJobs?.map((j) => (
                        <li key={j.webUrl}>
                          <a href={j.webUrl} target="_blank" rel="noreferrer">job {j.name}</a> <small>{j.stage}</small>
                        </li>
                      ))}
                      {r.failedTests?.map((t, i) => (
                        <li key={i}>
                          <span>{t.name}</span> <small>{t.suite}</small>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              ) : (
                <div className="pipe-line">No runs yet</div>
              )}
            </div>
          );
        })}
      </div>

    </div>
  );
}
