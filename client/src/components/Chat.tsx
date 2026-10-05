import { useEffect, useRef, useState } from "react";
import type { ChatItem } from "../types";

export default function Chat({
  items,
  busy,
  onSend,
}: {
  items: ChatItem[];
  busy: boolean;
  onSend: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items]);

  const submit = () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    onSend(text);
  };

  return (
    <section className="chat">
      <div className="chat-scroll" ref={scrollRef}>
        {items.length === 0 && (
          <div className="empty">
            <h3>Talk to the agent</h3>
            <p>
              It works directly in the selected repo. Try: <em>“Update the glossary page with a section on
              camera returns, and show me the diff.”</em>
            </p>
          </div>
        )}
        {items.map((item, i) => {
          switch (item.kind) {
            case "user":
              return (
                <div key={i} className="msg user">
                  {item.text}
                </div>
              );
            case "agent":
              return (
                <div key={i} className={`msg agent ${item.streaming ? "streaming" : ""}`}>
                  {item.text}
                </div>
              );
            case "tool":
              return (
                <div key={i} className="tool-chip">
                  ⚙ {item.name}
                </div>
              );
            case "error":
              return (
                <div key={i} className="msg error">
                  {item.text}
                </div>
              );
            case "meta":
              return (
                <div key={i} className="meta-line">
                  {item.text}
                </div>
              );
          }
        })}
        {busy && <div className="meta-line pulse">agent working…</div>}
      </div>
      <div className="composer">
        <textarea
          value={draft}
          placeholder={busy ? "Agent is working…" : "Message the agent…"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={2}
        />
        <button onClick={submit} disabled={busy || !draft.trim()}>
          Send
        </button>
      </div>
    </section>
  );
}
