import { useCallback, useEffect, useState } from "react";
import { api } from "../net";

interface Status {
  state: "stopped" | "starting" | "running" | "error";
  port: number;
  log: string[];
}

export default function Preview({ wsKey }: { wsKey: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const refresh = useCallback(() => {
    api(`/api/preview/${wsKey}/status`).then((r) => r.json()).then(setStatus);
  }, [wsKey]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 2500);
    return () => clearInterval(id);
  }, [refresh]);

  const start = () => api(`/api/preview/${wsKey}/start`, { method: "POST" }).then((r) => r.json()).then(setStatus);
  const stop = () => api(`/api/preview/${wsKey}/stop`, { method: "POST" }).then((r) => r.json()).then(setStatus);

  const running = status?.state === "running";
  const port = status?.port;

  return (
    <div className="preview">
      <div className="preview-bar">
        <span className={`dot ${status?.state ?? "stopped"}`} />
        <span className="preview-state">mkdocs · {status?.state ?? "…"}</span>
        {running ? (
          <>
            <button onClick={() => setReloadKey((k) => k + 1)}>Reload</button>
            <button onClick={stop}>Stop</button>
            <a href={`http://127.0.0.1:${port}`} target="_blank" rel="noreferrer">
              open ↗
            </a>
          </>
        ) : (
          <button onClick={start} disabled={status?.state === "starting"}>
            {status?.state === "starting" ? "Starting…" : "Start preview"}
          </button>
        )}
      </div>
      {running ? (
        <iframe key={reloadKey} title="MkDocs preview" src={`http://127.0.0.1:${port}`} className="preview-frame" />
      ) : (
        <div className="preview-placeholder">
          <p>
            Live render of this docs site. Start it, then ask the agent to edit a page —
            mkdocs hot-reloads as files change.
          </p>
          {status?.log?.length ? <pre className="preview-log">{status.log.join("\n")}</pre> : null}
        </div>
      )}
    </div>
  );
}
