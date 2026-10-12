import { config } from "./config.js";
import { glab, parseRemote, run } from "./pipelines.js";

/**
 * Home screen inbox: open merge requests (GitLab, via the user's glab login) and
 * pull requests (GitHub, via gh) that are waiting for you, or that you opened.
 */

export interface InboxMr {
  source: "gitlab" | "github";
  host: string;
  project: string;
  iid: number;
  title: string;
  url: string;
  author: string;
  role: "review" | "assigned" | "mine";
  draft: boolean;
  updatedAt: string;
  /** Workspace whose git remote is this project, if any. */
  ws: string | null;
}

interface GlMr {
  iid: number;
  title: string;
  web_url: string;
  draft?: boolean;
  work_in_progress?: boolean;
  updated_at: string;
  author: { username: string };
  references?: { full?: string };
}

let cache: { at: number; data: { items: InboxMr[]; errors: string[] } } | null = null;

/** Every workspace's origin remote → host + project path. */
async function remotes() {
  const out: { ws: string; host: string; project: string }[] = [];
  await Promise.all(
    Object.entries(config.repos).map(async ([ws, repo]) => {
      const url = await run("git", ["-C", repo.path, "remote", "get-url", "origin"]).catch(() => "");
      const r = url ? parseRemote(url) : null;
      if (r) out.push({ ws, ...r });
    }),
  );
  return out;
}

async function gitlab(host: string): Promise<InboxMr[]> {
  const me = await glab<{ id: number; username: string }>(host, "user");
  const q = "merge_requests?state=opened&per_page=50";
  const [review, assigned, mine] = await Promise.all([
    glab<GlMr[]>(host, `${q}&scope=all&reviewer_id=${me.id}`),
    glab<GlMr[]>(host, `${q}&scope=assigned_to_me`),
    glab<GlMr[]>(host, `${q}&scope=created_by_me`),
  ]);
  const seen = new Set<string>();
  const out: InboxMr[] = [];
  const add = (list: GlMr[], role: InboxMr["role"]) => {
    for (const m of list) {
      if (seen.has(m.web_url)) continue;
      seen.add(m.web_url);
      const project = (m.references?.full ?? "").replace(/!\d+$/, "") || new URL(m.web_url).pathname.split("/-/")[0].slice(1);
      out.push({
        source: "gitlab",
        host,
        project,
        iid: m.iid,
        title: m.title.replace(/^(Draft|WIP):\s*/i, ""),
        url: m.web_url,
        author: m.author.username,
        // An MR you opened and are assigned to is still "yours".
        role: role === "assigned" && m.author.username === me.username ? "mine" : role,
        draft: !!(m.draft ?? m.work_in_progress),
        updatedAt: m.updated_at,
        ws: null,
      });
    }
  };
  add(review, "review");
  add(assigned, "assigned");
  add(mine, "mine");
  return out;
}

async function github(): Promise<InboxMr[]> {
  const fields = "number,title,url,author,isDraft,updatedAt,repository";
  const search = async (flag: string, role: InboxMr["role"]) => {
    const raw = await run("gh", ["search", "prs", flag, "--state=open", "--limit=30", "--json", fields]);
    return (
      JSON.parse(raw) as {
        number: number;
        title: string;
        url: string;
        author: { login: string };
        isDraft: boolean;
        updatedAt: string;
        repository: { nameWithOwner: string };
      }[]
    ).map(
      (p): InboxMr => ({
        source: "github",
        host: "github.com",
        project: p.repository.nameWithOwner,
        iid: p.number,
        title: p.title,
        url: p.url,
        author: p.author.login,
        role,
        draft: p.isDraft,
        updatedAt: p.updatedAt,
        ws: null,
      }),
    );
  };
  const [review, mine] = await Promise.all([search("--review-requested=@me", "review"), search("--author=@me", "mine")]);
  const urls = new Set(review.map((p) => p.url));
  return [...review, ...mine.filter((p) => !urls.has(p.url))];
}

export async function inboxMrs(refresh = false) {
  if (!refresh && cache && Date.now() - cache.at < 2 * 60_000) return cache.data;
  const repos = await remotes();
  const hosts = [...new Set(repos.map((r) => r.host).filter((h) => !h.includes("github")))];
  const errors: string[] = [];
  const lists = await Promise.all([
    ...hosts.map((h) =>
      gitlab(h).catch((err: Error) => {
        errors.push(`${h}: ${err.message}`);
        return [] as InboxMr[];
      }),
    ),
    // GitHub only when a workspace lives there (gh is otherwise just for updates).
    repos.some((r) => r.host.includes("github"))
      ? github().catch((err: Error) => {
          errors.push(`github.com: ${err.message}`);
          return [] as InboxMr[];
        })
      : Promise.resolve([] as InboxMr[]),
  ]);
  const items = lists
    .flat()
    .map((m) => ({ ...m, ws: repos.find((r) => r.host === m.host && r.project.toLowerCase() === m.project.toLowerCase())?.ws ?? null }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  cache = { at: Date.now(), data: { items, errors } };
  return cache.data;
}
