import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../net";
import "./accounts.css";

/**
 * Lab account switcher on the browser toolbar: the workspace's active
 * fixture and when its session expires; the menu lists every fixture with
 * its lock (free / held by …). Activating mints a session (server:
 * fixtures.ts), then logs this browser in with the cookies. Fixtures and
 * their secrets are edited in Settings → Lab accounts.
 */

export interface LockState {
  state: "free" | "held";
  mine?: boolean;
  by?: string;
  stale?: boolean;
}
export interface FixtureRow {
  id: string;
  label: string;
  placeholder: string;
  env: Record<string, string>;
  hosts: string[];
  mint: { command: string };
  account?: string;
  persona?: string;
  lock: LockState;
}
interface ActiveRow {
  ws: string;
  id: string;
  round: string | null;
  expiresAt: number | null;
  refreshAt: number | null;
  persona: string | null;
}
export interface FixtureList {
  qaRoot: string;
  fixtures: FixtureRow[];
  active: ActiveRow[];
}

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Log the in-app browser in (browser.rs browser_import_cookies). A refresh keeps the page. */
async function importCookies(cookies: string[], reload: boolean) {
  if (!isTauri || !cookies.length) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke<number>("browser_import_cookies", { cookies, reload });
}

async function json<T>(res: Promise<Response>): Promise<T> {
  const r = await res;
  const body = await r.json();
  if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
  return body as T;
}

/** "34m", "4:05" under 10 minutes, "expired". */
function left(ms: number): string {
  if (ms <= 0) return "expired";
  const s = Math.floor(ms / 1000);
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export default function AccountPill({ ws, onMenu }: { ws: string; onMenu: (open: boolean) => void }) {
  const [data, setData] = useState<FixtureList | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const roundKey = `crux.accountRound.${ws}`;
  const [round, setRound] = useState(() => localStorage.getItem(roundKey) ?? "");
  const box = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    void json<FixtureList>(api("/api/fixtures"))
      .then(setData)
      .catch(() => setData(null));
  }, []);
  useEffect(load, [load, ws]);
  useEffect(() => setRound(localStorage.getItem(roundKey) ?? ""), [roundKey]);

  const show = (next: boolean) => {
    setOpen(next);
    onMenu(next);
    if (next) {
      setError("");
      load();
    }
  };
  useEffect(() => () => onMenu(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Server events: another workspace took or freed an account, or this one's session was refreshed.
  useEffect(() => {
    const on = (e: Event) => {
      const msg = (e as CustomEvent).detail ?? {};
      if (msg.type === "account:refreshed" && msg.ws === ws) {
        void json<{ cookies: string[] }>(api(`/api/fixtures/active/${encodeURIComponent(ws)}/cookies`))
          .then((r) => importCookies(r.cookies, false))
          .catch(() => undefined);
        setError("");
      }
      if (msg.type === "account:error" && msg.ws === ws) setError(String(msg.error ?? "Refresh failed"));
      load();
    };
    window.addEventListener("crux:account", on);
    return () => window.removeEventListener("crux:account", on);
  }, [ws, load]);

  const current = data?.active.find((a) => a.ws === ws);
  const fixture = current && data?.fixtures.find((f) => f.id === current.id);
  useEffect(() => {
    if (!current?.expiresAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [current?.expiresAt]);

  // Close on a click outside or Esc.
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => !box.current?.contains(e.target as Node) && show(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && show(false);
    window.addEventListener("pointerdown", down);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("keydown", key);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const activate = async (f: FixtureRow) => {
    setBusy(f.id);
    setError("");
    try {
      localStorage.setItem(roundKey, round.trim());
      const r = await json<{ cookies?: string[] }>(
        api(`/api/fixtures/${encodeURIComponent(f.id)}/activate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ws, round: round.trim() || undefined }),
        }),
      );
      await importCookies(r.cookies ?? [], true);
      show(false);
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setBusy("");
      load();
    }
  };
  const release = async (id: string) => {
    setBusy(id);
    try {
      await json(api(`/api/fixtures/${encodeURIComponent(id)}/release`, { method: "POST" }));
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setBusy("");
      load();
    }
  };

  const remaining = current?.expiresAt ? current.expiresAt - now : null;
  const title = fixture
    ? `${fixture.label} (${fixture.placeholder})${current?.refreshAt ? ` · refreshes at ${new Date(current.refreshAt).toLocaleTimeString()}` : ""}${error ? `\n${error}` : ""}`
    : "Lab account: pick a fixture to log in as";

  return (
    <div className="account-pill" ref={box}>
      <button className={`account-pill-btn ${fixture ? "on" : ""} ${error ? "error" : ""}`} title={title} onClick={() => show(!open)}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <circle cx="8" cy="5.5" r="2.6" />
          <path d="M2.8 13.5c.8-2.4 2.8-3.6 5.2-3.6s4.4 1.2 5.2 3.6" />
        </svg>
        <span className="account-pill-label">{fixture ? fixture.label : "Account"}</span>
        {remaining != null && <span className={`account-pill-time ${remaining < 5 * 60_000 ? "soon" : ""}`}>{left(remaining)}</span>}
      </button>
      {open && (
        <div className="account-menu" role="menu">
          <div className="account-menu-head">Lab account for this workspace</div>
          {!data || data.fixtures.length === 0 ? (
            <div className="account-empty">No fixtures yet: add them in Settings → Lab accounts.</div>
          ) : (
            data.fixtures.map((f) => {
              const here = current?.id === f.id;
              const heldElsewhere = f.lock.state === "held" && !(here && f.lock.mine);
              return (
                <div key={f.id} className={`account-row ${here ? "on" : ""}`}>
                  <span className="account-row-text">
                    <b>{f.label}</b>
                    <span className={heldElsewhere ? "held" : ""}>
                      {f.placeholder} · {here ? "active here" : f.lock.state === "free" ? "free" : `held by ${f.lock.by}`}
                    </span>
                  </span>
                  {here ? (
                    <>
                      <button disabled={!!busy} onClick={() => void activate(f)} title="Mint a fresh session now">
                        {busy === f.id ? "…" : "Refresh"}
                      </button>
                      <button disabled={!!busy} onClick={() => void release(f.id)}>
                        Release
                      </button>
                    </>
                  ) : (
                    <button className="primary" disabled={!!busy || heldElsewhere} onClick={() => void activate(f)}>
                      {busy === f.id ? "Logging in…" : current ? "Switch" : "Use"}
                    </button>
                  )}
                </div>
              );
            })
          )}
          <label className="account-round">
            <span>QA round</span>
            <input
              value={round}
              spellCheck={false}
              placeholder={`optional: folder under ${data?.qaRoot ?? "~/qa-runs"}`}
              onChange={(e) => setRound(e.target.value)}
            />
          </label>
          {current?.persona && <div className="account-note">Persona file: {current.persona}</div>}
          {error && <div className="account-error">{error}</div>}
        </div>
      )}
    </div>
  );
}
