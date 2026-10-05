import { useEffect, useMemo, useState } from "react";
import type { TreeResponse, RepoTree, TestFile } from "../types";
import { api } from "../net";

function FileNode({ file, filter }: { file: TestFile; filter: string }) {
  const [open, setOpen] = useState(false);
  const matches = (s: string) => s.toLowerCase().includes(filter);
  const visibleTests = filter
    ? file.tests.filter((t) => matches(t.title) || matches(file.path))
    : file.tests;
  if (filter && visibleTests.length === 0 && !matches(file.path)) return null;

  return (
    <div className="tree-file">
      <button className="tree-row" onClick={() => setOpen(!open)} title={file.path}>
        <span className="twisty">{open ? "▾" : "▸"}</span>
        <span className="file-path">{file.path.split("/").pop()}</span>
        <span className="count">{file.tests.length}</span>
      </button>
      {(open || !!filter) && (
        <div className="tree-children">
          {visibleTests.map((t) => (
            <div key={t.line} className="tree-test">
              <span className="test-dot" /> {t.title}
              <span className="line">:{t.line}</span>
            </div>
          ))}
          {file.endpoints.length > 0 && (
            <div className="endpoints">
              {file.endpoints.map((ep) => (
                <code key={ep}>{ep}</code>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function dirOf(path: string): string {
  const segments = path.split("/");
  return segments.slice(0, -1).join("/") || "(root)";
}

/** Longest-prefix lookup: "tests/rbac/admin" matches a "tests/rbac" entry. */
function describeDir(dir: string, descriptions?: Record<string, string>): string | undefined {
  if (!descriptions) return undefined;
  let probe = dir;
  for (;;) {
    if (descriptions[probe]) return descriptions[probe];
    const cut = probe.lastIndexOf("/");
    if (cut === -1) return undefined;
    probe = probe.slice(0, cut);
  }
}

function DirSection({
  dir,
  files,
  filter,
  description,
}: {
  dir: string;
  files: TestFile[];
  filter: string;
  description?: string;
}) {
  const [open, setOpen] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const matches = (s: string) => s.toLowerCase().includes(filter);
  const visible = filter
    ? files.filter((f) => matches(f.path) || f.tests.some((t) => matches(t.title)))
    : files;
  if (filter && visible.length === 0) return null;
  const tests = files.reduce((n, f) => n + f.tests.length, 0);
  const expanded = open || !!filter;
  return (
    <div className="tree-dir">
      <div className="tree-row dir" onClick={() => setOpen(!open)} role="button" tabIndex={0}>
        <span className="twisty">{expanded ? "▾" : "▸"}</span>
        <span className="dir-name">{dir}/</span>
        {description && (
          <button
            className={`info-btn ${showInfo ? "on" : ""}`}
            title={showInfo ? "Hide description" : "What does this folder test?"}
            onClick={(e) => {
              e.stopPropagation();
              setShowInfo(!showInfo);
            }}
          >
            i
          </button>
        )}
        <span className="count">{files.length} files · {tests} tests</span>
      </div>
      {showInfo && description && <p className="dir-desc">{description}</p>}
      {expanded && (
        <div className="dir-children">
          {visible.map((f) => (
            <FileNode key={f.path} file={f} filter={filter} />
          ))}
        </div>
      )}
    </div>
  );
}

function RepoSection({
  tree,
  filter,
  descriptions,
}: {
  tree: RepoTree;
  filter: string;
  descriptions?: Record<string, string>;
}) {
  const totalTests = tree.files.reduce((n, f) => n + f.tests.length, 0);
  const groups = useMemo(() => {
    const map = new Map<string, TestFile[]>();
    for (const f of tree.files) {
      const dir = dirOf(f.path);
      (map.get(dir) ?? map.set(dir, []).get(dir)!).push(f);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [tree]);
  return (
    <div className="tree-repo">
      <h4>
        {tree.label} <span className="kind-tag">{tree.kind}</span>
        <span className="count">{tree.files.length} files · {totalTests} tests</span>
      </h4>
      {tree.error && <p className="error-line">{tree.error}</p>}
      {groups.map(([dir, files]) => (
        <DirSection
          key={dir}
          dir={dir}
          files={files}
          filter={filter}
          description={describeDir(dir, descriptions)}
        />
      ))}
    </div>
  );
}

export default function TestTree({ repo }: { repo?: string }) {
  const [data, setData] = useState<TreeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const filter = query.trim().toLowerCase();

  const load = () => {
    setError(null);
    api("/api/tree")
      .then((r) => r.json())
      .then(setData)
      .catch((e) => setError(String(e)));
  };
  useEffect(load, []);

  const shared = useMemo(() => (repo ? [] : data?.shared ?? []), [data, repo]);
  const trees = useMemo(
    () => (data ? data.trees.filter((t) => !repo || t.key === repo) : []),
    [data, repo],
  );

  if (error) return <div className="tree"><p className="error-line">{error}</p></div>;
  if (!data) return <div className="tree"><p className="meta-line">Scanning test suites…</p></div>;

  return (
    <div className="tree">
      <div className="tree-bar">
        <input
          placeholder="Filter tests, files, endpoints…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button onClick={load}>Rescan</button>
      </div>
      <div className="tree-scroll">
      {shared.length > 0 && (
        <div className="shared-box">
          <h4>Endpoints covered by both suites</h4>
          {shared
            .filter((s) => !filter || s.endpoint.toLowerCase().includes(filter))
            .slice(0, 25)
            .map((s) => (
              <div key={s.endpoint} className="shared-row">
                <code>{s.endpoint}</code>
                <span>
                  {Object.entries(s.repos)
                    .map(([repo, files]) => `${repo}: ${files.length}`)
                    .join(" · ")}
                </span>
              </div>
            ))}
        </div>
      )}
      {trees.map((t) => (
        <RepoSection key={t.key} tree={t} filter={filter} descriptions={data.descriptions?.[t.key]} />
      ))}
      </div>
    </div>
  );
}
