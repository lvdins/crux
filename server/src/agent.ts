import { query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.js";

export type AgentEvent =
  | { type: "session"; id: string }
  | { type: "delta"; text: string }
  | { type: "block_end" }
  | { type: "tool"; name: string; summary?: string }
  | { type: "done"; costUsd?: number; durationMs?: number }
  | { type: "error"; message: string };

/**
 * One chat session = one Agent SDK conversation, resumed turn by turn via
 * session_id. cwd is the target repo so the agent works on real files.
 */
export class AgentSession {
  private sessionId?: string;
  busy = false;

  constructor(
    private cwd: string,
    private emit: (e: AgentEvent) => void,
  ) {}

  setCwd(cwd: string) {
    // Switching repo starts a fresh conversation — context from another repo
    // would only confuse the agent.
    if (cwd !== this.cwd) {
      this.cwd = cwd;
      this.sessionId = undefined;
    }
  }

  async send(text: string): Promise<void> {
    if (this.busy) {
      this.emit({ type: "error", message: "Agent is still working — wait for it to finish." });
      return;
    }
    this.busy = true;
    try {
      const q = query({
        prompt: text,
        options: {
          cwd: this.cwd,
          resume: this.sessionId,
          permissionMode: config.agent.permissionMode,
          includePartialMessages: true,
        },
      });

      for await (const message of q) {
        if (message.type === "system" && (message as any).subtype === "init") {
          this.sessionId = (message as any).session_id;
          this.emit({ type: "session", id: this.sessionId! });
        } else if (message.type === "stream_event") {
          const event = (message as any).event;
          if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
            this.emit({ type: "tool", name: event.content_block.name });
          } else if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
            this.emit({ type: "delta", text: event.delta.text });
          } else if (event.type === "content_block_stop") {
            this.emit({ type: "block_end" });
          }
        } else if (message.type === "result") {
          const r = message as any;
          this.sessionId = r.session_id ?? this.sessionId;
          if (r.is_error) {
            this.emit({ type: "error", message: r.result ?? r.subtype ?? "Agent run failed" });
          }
          this.emit({ type: "done", costUsd: r.total_cost_usd, durationMs: r.duration_ms });
        }
      }
    } catch (err: any) {
      this.emit({ type: "error", message: String(err?.message ?? err) });
      this.emit({ type: "done" });
    } finally {
      this.busy = false;
    }
  }
}
