import { execFile } from "node:child_process";

/**
 * Scheduled CI runs (e.g. "Daily tester" 06:00 / "Evening Tester" 22:00) of a
 * workspace's GitLab project, read through the user's own `glab` login, so
 * Crux never stores a token.
 */

export interface PipelineRun {
  id: number;
  status: string;
  createdAt: string;
  updatedAt: string;
  webUrl: string;
  /** Only for the latest run of each schedule. */
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

/** git@host:group/repo.git or https://host/group/repo(.git) → host + path. */
export function parseRemote(url: string): { host: string; project: string } | null {
  const ssh = /^[\w.-]+@([^:]+):(.+?)(\.git)?$/.exec(url.trim());
  if (ssh) return { host: ssh[1], project: ssh[2] };
  try {
    const u = new URL(url.trim());
    return { host: u.hostname, project: u.pathname.replace(/^\/+/, "").replace(/\.git$/, "") };
  } catch {
    return null;
  }
}

const run = (cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env) =>
  new Promise<string>((resolve, reject) =>
    execFile(cmd, args, { timeout: 20000, maxBuffer: 20 * 1024 * 1024, env }, (err, out, errOut) =>
      err ? reject(new Error((errOut || err.message).trim().split("\n")[0])) : resolve(out),
    ),
  );

async function glab<T>(host: string, endpoint: string): Promise<T> {
  try {
    return JSON.parse(await run("glab", ["api", "--hostname", host, endpoint])) as T;
  } catch (err) {
    // A GITLAB_TOKEN meant for another host overrides glab's saved login.
    if (!process.env.GITLAB_TOKEN) throw err;
    const { GITLAB_TOKEN: _t, ...env } = process.env;
    return JSON.parse(await run("glab", ["api", "--hostname", host, endpoint], env)) as T;
  }
}

const cache = new Map<string, { at: number; data: PipelineInfo }>();

export async function pipelinesFor(repoPath: string, refresh = false): Promise<PipelineInfo> {
  const hit = cache.get(repoPath);
  if (hit && !refresh && Date.now() - hit.at < 5 * 60_000) return hit.data;

  const remote = parseRemote(await run("git", ["-C", repoPath, "remote", "get-url", "origin"]));
  if (!remote) throw new Error("No GitLab remote (origin) for this folder");
  const { host, project } = remote;
  const p = `projects/${encodeURIComponent(project)}`;

  const schedules = await glab<any[]>(host, `${p}/pipeline_schedules?per_page=50`);
  const out: Schedule[] = await Promise.all(
    schedules.map(async (s): Promise<Schedule> => {
      const list = await glab<any[]>(host, `${p}/pipeline_schedules/${s.id}/pipelines?per_page=7&sort=desc`).catch(() => []);
      const runs: PipelineRun[] = list.map((r) => ({
        id: r.id,
        status: r.status,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        webUrl: r.web_url,
      }));
      // Details for the latest run only: duration, test counts, what failed.
      const last = runs[0];
      if (last) {
        const [detail, summary, jobs] = await Promise.all([
          glab<any>(host, `${p}/pipelines/${last.id}`).catch(() => null),
          glab<any>(host, `${p}/pipelines/${last.id}/test_report_summary`).catch(() => null),
          glab<any[]>(host, `${p}/pipelines/${last.id}/jobs?scope[]=failed&per_page=50`).catch(() => []),
        ]);
        last.duration = detail?.duration ?? null;
        const t = summary?.total;
        if (t?.count) last.tests = { count: t.count, success: t.success, failed: t.failed, skipped: t.skipped, error: t.error };
        last.failedJobs = jobs.map((j) => ({ name: j.name, stage: j.stage, webUrl: j.web_url }));
        if (t && t.failed + t.error > 0) {
          const report = await glab<any>(host, `${p}/pipelines/${last.id}/test_report`).catch(() => null);
          last.failedTests = (report?.test_suites ?? [])
            .flatMap((suite: any) =>
              (suite.test_cases ?? [])
                .filter((c: any) => c.status === "failed" || c.status === "error")
                .map((c: any) => ({ name: c.name, suite: c.classname || suite.name })),
            )
            .slice(0, 25);
        }
      }
      return {
        id: s.id,
        description: s.description,
        cron: s.cron,
        timezone: s.cron_timezone,
        active: s.active,
        nextRunAt: s.next_run_at ?? null,
        runs,
      };
    }),
  );

  const data: PipelineInfo = {
    host,
    project,
    webUrl: `https://${host}/${project}`,
    // Active schedules first, then by time of day (cron hour).
    schedules: out.sort((a, b) => Number(b.active) - Number(a.active) || hourOf(a.cron) - hourOf(b.cron)),
    fetchedAt: new Date().toISOString(),
  };
  cache.set(repoPath, { at: Date.now(), data });
  return data;
}

const hourOf = (cron: string) => Number(cron.split(/\s+/)[1]) || 0;
