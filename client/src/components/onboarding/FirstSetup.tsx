import { useState } from "react";
import SetupChecklist from "../SetupChecklist";
import { useModalKeys } from "../../useModalKeys";
import { ClaudeLogo, CodexLogo, TerminalIcon } from "../icons";
import type { RepoInfo } from "../../types";

type Kind = "claude" | "codex" | "shell";

const STEPS = ["Check tools", "Add a workspace", "Start a chat"];

/**
 * Guided first setup: tools check, first workspace (opens the normal Add
 * workspace dialog), then a named first chat.
 */
export default function FirstSetup({
  name: userName,
  repos,
  onAddWorkspace,
  onStartChat,
  onFinish,
}: {
  name: string;
  repos: Record<string, RepoInfo>;
  onAddWorkspace: () => void;
  onStartChat: (key: string, kind: Kind, name: string) => void;
  onFinish: () => void;
}) {
  const [step, setStep] = useState(0);
  const keys = Object.keys(repos);
  const [ws, setWs] = useState<string>("");
  const [kind, setKind] = useState<Kind>("claude");
  const [name, setName] = useState("");
  // Newest workspace by default, so the one just added is picked.
  const target = keys.includes(ws) ? ws : keys[keys.length - 1] ?? "";

  const next = () => {
    if (step === 1 && keys.length === 0) return;
    if (step < 2) setStep(step + 1);
    else if (keys.length) onStartChat(target, kind, name);
    else onFinish();
  };
  useModalKeys(true, { onEnter: next, onEscape: onFinish });

  return (
    <div className="onb-backdrop">
      <div className="onb-card setup" role="dialog" aria-label="Set up Crux">
        <aside className="fs-steps">
          <div className="fs-steps-title">{userName ? `Hi ${userName}` : "First setup"}</div>
          {STEPS.map((s, n) => (
            <button
              key={s}
              className={`fs-step ${n === step ? "on" : ""} ${n < step || (n === 1 && keys.length > 0) ? "done" : ""}`}
              onClick={() => setStep(n)}
            >
              <span className="fs-step-num">{n < step ? "✓" : n + 1}</span>
              {s}
            </button>
          ))}
        </aside>
        <section className="fs-main">
          {step === 0 && (
            <>
              <h2>Check your tools</h2>
              <p>Crux uses these command-line tools. Missing ones only switch off the feature next to them. Copy the command to install.</p>
              <SetupChecklist />
            </>
          )}
          {step === 1 && (
            <>
              <h2>Add your first workspace</h2>
              <p>Pick a repo folder: docs, Playwright, pytest, or any code repo. It stays where it is.</p>
              {keys.length > 0 && (
                <ul className="fs-ws-list">
                  {keys.map((k) => (
                    <li key={k}>
                      <span className="fs-ws-ok">✓</span> {repos[k].label}
                      <small>{repos[k].path}</small>
                    </li>
                  ))}
                </ul>
              )}
              <button className={keys.length ? "" : "primary"} onClick={onAddWorkspace}>
                + {keys.length ? "Add another" : "Add workspace"}
              </button>
            </>
          )}
          {step === 2 && (
            <>
              <h2>Start your first chat</h2>
              {keys.length === 0 ? (
                <p>Add a workspace first, so the chat has a folder to work in.</p>
              ) : (
                <>
                  <p>Pick where and with what. You can rename or add more chats later with + next to a workspace.</p>
                  <label className="fs-field">
                    <span>Workspace</span>
                    <select value={target} onChange={(e) => setWs(e.target.value)}>
                      {keys.map((k) => (
                        <option key={k} value={k}>{repos[k].label}</option>
                      ))}
                    </select>
                  </label>
                  <div className="fs-kinds">
                    {([
                      ["claude", <ClaudeLogo />, "Claude"],
                      ["codex", <CodexLogo />, "Codex"],
                      ["shell", <TerminalIcon />, "Terminal"],
                    ] as const).map(([k, icon, label]) => (
                      <button key={k} className={`fs-kind ${kind === k ? "on" : ""}`} onClick={() => setKind(k)}>
                        {icon}
                        {label}
                      </button>
                    ))}
                  </div>
                  <label className="fs-field">
                    <span>Name</span>
                    <input
                      className="chat-name-input"
                      value={name}
                      placeholder={kind}
                      spellCheck={false}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </label>
                </>
              )}
            </>
          )}
          <div className="onb-foot">
            <button className="onb-link" onClick={onFinish}>Skip setup</button>
            <span className="onb-spacer" />
            {step > 0 && <button onClick={() => setStep(step - 1)}>Back</button>}
            {step < 2 ? (
              <button className="primary" disabled={step === 1 && keys.length === 0} onClick={() => setStep(step + 1)}>
                Continue
              </button>
            ) : (
              <button
                className="primary"
                onClick={() => (keys.length ? onStartChat(target, kind, name) : onFinish())}
              >
                {keys.length ? "Start chat" : "Finish"}
              </button>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
