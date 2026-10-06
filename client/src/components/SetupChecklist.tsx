import { useEffect, useState } from "react";
import { api } from "../net";

interface Tool {
  name: string;
  path: string | null;
  version: string | null;
  needed: string;
  install: string;
}

/** Which command-line tools QualityLab found, with install hints. */
export default function SetupChecklist() {
  const [tools, setTools] = useState<Tool[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = () =>
    api("/api/system")
      .then((r) => r.json())
      .then((d) => setTools(d.tools))
      .catch(() => setTools([]));

  useEffect(() => {
    void load();
  }, []);

  if (!tools) return <div className="setup-list loading-row">Checking tools…</div>;
  const missing = tools.filter((t) => !t.path).length;

  return (
    <div className="setup-list">
      <div className="setup-head">
        <span>{missing === 0 ? "All tools found" : `${missing} tool${missing === 1 ? "" : "s"} missing`}</span>
        <button onClick={() => void load()}>Re-check</button>
      </div>
      {tools.map((t) => (
        <div key={t.name} className={`setup-row ${t.path ? "ok" : "miss"}`}>
          <span className="setup-mark">{t.path ? "✓" : "✗"}</span>
          <span className="setup-name">{t.name}</span>
          <span className="setup-why">{t.path ? t.version ?? t.path : t.needed}</span>
          {!t.path && (
            <button
              className="setup-install"
              title="Copy install command"
              onClick={() => {
                void navigator.clipboard.writeText(t.install).catch(() => undefined);
                setCopied(t.name);
                setTimeout(() => setCopied(null), 1400);
              }}
            >
              <code>{t.install}</code>
              <span>{copied === t.name ? "copied" : "copy"}</span>
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
