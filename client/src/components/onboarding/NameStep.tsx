import { useState } from "react";

/** "Let's start with your name" — required before the welcome cards. */
export default function NameStep({ initial, onDone }: { initial: string; onDone: (name: string) => void }) {
  const [name, setName] = useState(initial);
  const ok = name.trim().length > 0;

  return (
    <div className="onb-backdrop">
      <form
        className="onb-card name-step"
        role="dialog"
        aria-label="Your name"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) onDone(name.trim());
        }}
      >
        <img src="/crux-mark.svg" alt="" className="name-mark" />
        <h2>Let's start with your name</h2>
        <p>Crux uses it to greet you.</p>
        <input
          className="chat-name-input name-input"
          value={name}
          placeholder="Your name"
          autoFocus
          spellCheck={false}
          autoComplete="given-name"
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" className="primary" disabled={!ok}>
          Continue
        </button>
      </form>
    </div>
  );
}
