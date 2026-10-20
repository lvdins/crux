import { useEffect, useState } from "react";
import { api } from "../net";
import type { FixtureList } from "./AccountPill";
import "./accounts.css";

async function json<T>(res: Promise<Response>): Promise<T> {
  const r = await res;
  const body = await r.json();
  if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
  return body as T;
}

const EXAMPLE = [
  {
    id: "cs-admin",
    label: "Native CS admin",
    placeholder: "<CS_ADMIN>",
    env: { LAB_EMAIL: "cs-admin-email", LAB_PASSWORD: "cs-admin-password" },
    hosts: ["lab.example.com"],
    mint: { command: "node scripts/mint-session.cjs" },
  },
];

/**
 * Settings → Lab accounts: the fixtures list (CRUX_HOME/fixtures.json, no
 * secrets) and the Keychain secrets its mint scripts get. Secrets are
 * write-only here: Crux shows whether one is set, never its value.
 */
export default function LabAccountsSettings() {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [secrets, setSecrets] = useState<{ name: string; set: boolean }[] | null>(null);
  const [secretError, setSecretError] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState("");

  const loadSecrets = () =>
    void json<{ name: string; set: boolean }[]>(api("/api/secrets"))
      .then((list) => {
        setSecrets(list);
        setSecretError("");
      })
      .catch((err) => {
        setSecrets([]);
        setSecretError(String(err.message ?? err));
      });

  useEffect(() => {
    void json<FixtureList>(api("/api/fixtures"))
      .then((d) => setText(JSON.stringify(d.fixtures.map(({ lock: _lock, ...f }) => f), null, 2)))
      .catch(() => setText("[]"));
    loadSecrets();
  }, []);

  const saveFixtures = async () => {
    let list: unknown;
    try {
      list = JSON.parse(text);
    } catch {
      setStatus({ ok: false, text: "Not valid JSON" });
      return;
    }
    try {
      const d = await json<FixtureList>(
        api("/api/fixtures", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fixtures: list }) }),
      );
      setText(JSON.stringify(d.fixtures.map(({ lock: _lock, ...f }) => f), null, 2));
      setStatus({ ok: true, text: `Saved ${d.fixtures.length} fixture${d.fixtures.length === 1 ? "" : "s"}` });
      loadSecrets();
    } catch (err) {
      setStatus({ ok: false, text: String((err as Error).message ?? err) });
    }
  };

  const setSecret = async (name: string) => {
    const value = values[name] ?? "";
    if (!value) return;
    try {
      await json(api(`/api/secrets/${encodeURIComponent(name)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value }) }));
      setValues((v) => ({ ...v, [name]: "" }));
      if (name === newName) setNewName("");
      loadSecrets();
    } catch (err) {
      setSecretError(String((err as Error).message ?? err));
    }
  };
  const deleteSecret = async (name: string) => {
    try {
      await json(api(`/api/secrets/${encodeURIComponent(name)}`, { method: "DELETE" }));
      loadSecrets();
    } catch (err) {
      setSecretError(String((err as Error).message ?? err));
    }
  };

  const secretRow = (name: string, set: boolean | null) => (
    <div key={name || "new"} className="secret-row">
      {set === null ? (
        <input value={newName} placeholder="new secret name" spellCheck={false} onChange={(e) => setNewName(e.target.value.replace(/[^\w.-]/g, ""))} />
      ) : (
        <code>{name}</code>
      )}
      {set !== null && <span className={`secret-state ${set ? "set" : ""}`}>{set ? "set" : "not set"}</span>}
      <input
        type="password"
        autoComplete="off"
        placeholder={set ? "new value" : "value"}
        value={values[name] ?? ""}
        onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
        onKeyDown={(e) => e.key === "Enter" && void setSecret(name)}
      />
      <button className="primary" disabled={!name || !values[name]} onClick={() => void setSecret(name)}>
        Save
      </button>
      {set && <button onClick={() => void deleteSecret(name)}>Delete</button>}
    </div>
  );

  return (
    <div className="accounts-settings">
      <p className="settings-note first">
        Named lab accounts for the account pill on the browser. Picking one takes the QA account lock, runs the fixture's mint script
        with its secrets as env, logs the browser in, writes the round's Playwright persona file and gives this workspace's new agents
        the session. Agents and published text see only the placeholder.
      </p>
      <div className="settings-section">Fixtures</div>
      <p className="settings-note">
        <code>env</code> maps the mint script's variable to a secret name below. The script prints JSON{" "}
        <code>{"{cookies, storageState, env, expiresAt}"}</code>. Example: <code>{JSON.stringify(EXAMPLE[0].env)}</code>
      </p>
      <textarea
        value={text}
        spellCheck={false}
        placeholder={JSON.stringify(EXAMPLE, null, 2)}
        onChange={(e) => {
          setText(e.target.value);
          setStatus(null);
        }}
      />
      <div className="accounts-actions">
        <button className="primary" onClick={() => void saveFixtures()}>
          Save fixtures
        </button>
        {status && <span className={`accounts-status ${status.ok ? "" : "error"}`}>{status.text}</span>}
      </div>
      <div className="settings-section">Secrets (macOS Keychain)</div>
      <div className="settings-list">
        {secrets?.map((s) => secretRow(s.name, s.set))}
        {secretRow(newName, null)}
      </div>
      {secretError && <p className="settings-note warn">{secretError}</p>}
    </div>
  );
}
