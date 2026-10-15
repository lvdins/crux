import { useEffect, useMemo, useState } from "react";
import { api } from "../net";

interface Source {
  browser: string;
  name: string;
  profile: string;
  profileName: string;
}

const invoke = <T,>(cmd: string, args?: Record<string, unknown>) =>
  import("@tauri-apps/api/core").then(({ invoke }) => invoke<T>(cmd, args));

async function json<T>(res: Promise<Response>): Promise<T> {
  const r = await res;
  const body = await r.json();
  if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
  return body as T;
}

/**
 * Settings → Tabs & views: copy logins (cookies) for the sites you pick from
 * Arc / Chrome into Crux's browser. Nothing is decrypted until you import,
 * and only for the ticked sites (macOS asks to allow the keychain key).
 */
export default function ImportLogins() {
  const [sources, setSources] = useState<Source[] | null>(null);
  const [source, setSource] = useState("");
  const [sites, setSites] = useState<{ site: string; cookies: number }[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    void json<Source[]>(api("/api/browser-import/sources"))
      .then((list) => {
        setSources(list);
        if (list[0]) setSource(`${list[0].browser}/${list[0].profile}`);
      })
      .catch(() => setSources([]));
  }, []);

  const current = sources?.find((s) => `${s.browser}/${s.profile}` === source);
  useEffect(() => {
    if (!current) return;
    setSites(null);
    setPicked(new Set());
    setStatus(null);
    const q = new URLSearchParams({ browser: current.browser, profile: current.profile });
    void json<{ site: string; cookies: number }[]>(api(`/api/browser-import/sites?${q}`))
      .then(setSites)
      .catch((err) => {
        setSites([]);
        setStatus({ ok: false, text: String(err.message ?? err) });
      });
  }, [source]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sites matching the search (all of them when there's none).
  const matching = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (sites ?? []).filter((s) => !f || s.site.includes(f));
  }, [sites, filter]);
  const shown = useMemo(() => {
    // Picked ones stay visible while filtering.
    const f = filter.trim().toLowerCase();
    return (f ? (sites ?? []).filter((s) => s.site.includes(f) || picked.has(s.site)) : matching).slice(0, 200);
  }, [sites, matching, filter, picked]);
  const allPicked = matching.length > 0 && matching.every((s) => picked.has(s.site));
  // Select all: every site matching the search, not just the 200 listed.
  const pickAll = () =>
    setPicked((p) => {
      const next = new Set(p);
      for (const s of matching) {
        if (allPicked) next.delete(s.site);
        else next.add(s.site);
      }
      return next;
    });

  const toggle = (site: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(site)) next.delete(site);
      else next.add(site);
      return next;
    });

  const run = async () => {
    if (!current || !picked.size) return;
    setBusy(true);
    setStatus({ ok: true, text: "Waiting for the keychain: click Allow in the macOS prompt…" });
    try {
      const res = await json<{ cookies: string[]; skipped: number; sites: number }>(
        api("/api/browser-import/cookies", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ browser: current.browser, profile: current.profile, sites: [...picked] }),
        }),
      );
      const n = await invoke<number>("browser_import_cookies", { cookies: res.cookies });
      setStatus({
        ok: true,
        text: `Imported ${n} cookies for ${res.sites} site${res.sites === 1 ? "" : "s"}${res.skipped ? ` (${res.skipped} unreadable skipped)` : ""}. Open them in Crux's browser.`,
      });
      setPicked(new Set());
    } catch (err) {
      setStatus({ ok: false, text: String((err as Error).message ?? err) });
    } finally {
      setBusy(false);
    }
  };

  if (sources && !sources.length) {
    return <p className="settings-note">No Arc, Chrome, Brave or Edge profiles found.</p>;
  }

  return (
    <div className="import-logins">
      <div className="import-head">
        <select className="settings-input import-source" value={source} onChange={(e) => setSource(e.target.value)} disabled={!sources}>
          {(sources ?? []).map((s) => (
            <option key={`${s.browser}/${s.profile}`} value={`${s.browser}/${s.profile}`}>
              {s.name} · {s.profileName}
            </option>
          ))}
        </select>
        <input className="settings-input import-filter" placeholder="Find a site, e.g. atlassian" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="import-sites">
        {sites === null ? (
          <p className="settings-note">Reading sites…</p>
        ) : !shown.length ? (
          <p className="settings-note">No sites{filter ? " match" : ""}.</p>
        ) : (
          <>
            <label className="import-site import-all">
              <input type="checkbox" checked={allPicked} onChange={pickAll} />
              <span>{filter.trim() ? `Select all matching “${filter.trim()}”` : "Select all"}</span>
              <small>{matching.length}</small>
            </label>
            {shown.map((s) => (
              <label key={s.site} className={`import-site ${picked.has(s.site) ? "on" : ""}`}>
                <input type="checkbox" checked={picked.has(s.site)} onChange={() => toggle(s.site)} />
                <span>{s.site}</span>
                <small>{s.cookies}</small>
              </label>
            ))}
          </>
        )}
      </div>
      <div className="import-foot">
        {status && <span className={`import-status ${status.ok ? "" : "error"}`}>{status.text}</span>}
        <button className="settings-btn-sm primary" disabled={busy || !picked.size} onClick={() => void run()}>
          {busy ? "Importing…" : `Import ${picked.size || ""} site${picked.size === 1 ? "" : "s"}`}
        </button>
      </div>
    </div>
  );
}
