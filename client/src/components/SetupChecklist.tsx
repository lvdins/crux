import { useEffect, useState } from "react";
import { api } from "../net";

export interface ToolHealth {
  name: string;
  needed: string;
  required: boolean;
  path: string | null;
  version: string | null;
  login: null | { ok: boolean; detail: string };
  fix: string | null;
}

/** Required tools that are missing or logged out (the dot on the Settings gear). */
export const setupIssues = (tools: ToolHealth[]) => tools.filter((t) => t.required && t.fix).length;

/**
 * Which command-line tools Crux found, and whether they're logged in.
 * `onFix` runs the fixing command in a terminal; without it, it's copied.
 */
export default function SetupChecklist({
  onFix,
  onChecked,
}: {
  onFix?: (cmd: string, tool: string) => void;
  onChecked?: (tools: ToolHealth[]) => void;
}) {
  const [tools, setTools] = useState<ToolHealth[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setBusy(true);
    api("/api/health")
      .then((r) => r.json())
      .then((d: { tools: ToolHealth[] }) => {
        setTools(d.tools);
        onChecked?.(d.tools);
      })
      .catch(() => setTools([]))
      .finally(() => setBusy(false));
  };

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!tools) return <div className="setup-list loading-row">Checking tools and logins…</div>;
  const problems = tools.filter((t) => t.fix);
  const required = problems.filter((t) => t.required).length;

  return (
    <div className="setup-list">
      <div className="setup-head">
        <span>
          {problems.length === 0
            ? "Everything is installed and logged in"
            : required
              ? `${required} thing${required === 1 ? "" : "s"} to fix`
              : "Optional tools missing"}
        </span>
        <button disabled={busy} onClick={load}>
          {busy ? "Checking…" : "Re-check"}
        </button>
      </div>
      {tools.map((t) => {
        const ok = !t.fix;
        const status = !t.path ? t.needed : t.login && !t.login.ok ? t.login.detail : t.login?.detail ?? t.version ?? t.path;
        return (
          <div key={t.name} className={`setup-row ${ok ? "ok" : t.required ? "miss" : "opt"}`} title={t.needed}>
            <span className="setup-mark">{ok ? "✓" : t.required ? "✗" : "–"}</span>
            <span className="setup-name">{t.name}</span>
            <span className="setup-why">{status}</span>
            {t.fix && (
              <button
                className="setup-install"
                title={onFix ? "Run this in a terminal" : "Copy the command"}
                onClick={() => {
                  if (onFix) return onFix(t.fix!, t.name);
                  void navigator.clipboard.writeText(t.fix!).catch(() => undefined);
                  setCopied(t.name);
                  setTimeout(() => setCopied(null), 1400);
                }}
              >
                <code>{t.fix}</code>
                <span>{onFix ? (t.path ? "Log in" : "Install") : copied === t.name ? "copied" : "copy"}</span>
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
