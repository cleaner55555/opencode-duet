import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";

export interface RunPromptOptions {
  prompt: string;
  sessionId: string;
  cwd?: string;
  model?: string;
  agent?: string;
  auto?: boolean;
  timeoutMs?: number;
}

export type BridgeEvent =
  | { type: "text"; text: string }
  | { type: "tool"; tool: string; input: unknown; output?: string }
  | { type: "step"; reason?: string; cost?: number }
  | { type: "log"; message: string }
  | { type: "error"; message: string }
  | { type: "done"; exitCode: number | null; sessionId: string };

export interface AgentBridge extends EventEmitter {
  run(options: RunPromptOptions): Promise<void>;
  cancel(): void;
  isBusy(): boolean;
  lastSessionId(): string | null;
}

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export class OpenCodeBridge extends EventEmitter implements AgentBridge {
  private child: ChildProcess | null = null;
  private timeout: NodeJS.Timeout | null = null;
  private session: string | null = null;

  isBusy(): boolean {
    return this.child !== null;
  }

  lastSessionId(): string | null {
    return this.session;
  }

  cancel(): void {
    if (this.child) {
      this.child.kill("SIGTERM");
      this.child = null;
    }
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }

  async run(options: RunPromptOptions): Promise<void> {
    if (this.child) {
      throw new Error("OpenCode is already running a prompt");
    }

    const args = ["run", "--format", "json", "--session", options.sessionId];
    if (options.model) args.push("--model", options.model);
    if (options.agent) args.push("--agent", options.agent);
    if (options.auto) args.push("--auto");
    args.push("--", options.prompt);

    this.session = options.sessionId;

    return new Promise((resolve) => {
      let stderr = "";
      let settled = false;

      const finish = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        if (this.timeout) {
          clearTimeout(this.timeout);
          this.timeout = null;
        }
        this.child = null;
        this.emit("event", {
          type: "done",
          exitCode,
          sessionId: this.session ?? options.sessionId,
        } satisfies BridgeEvent);
        resolve();
      };

      let child: ChildProcess;
      try {
        child = spawn("opencode", args, {
          cwd: options.cwd ?? process.cwd(),
          env: { ...process.env, OPENCODE_DUET: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.emit("event", { type: "error", message } satisfies BridgeEvent);
        finish(1);
        return;
      }

      this.child = child;

      this.timeout = setTimeout(() => {
        this.emit("event", {
          type: "error",
          message: `OpenCode timed out after ${Math.round(
            (options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000,
          )}s`,
        } satisfies BridgeEvent);
        child.kill("SIGTERM");
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

      if (child.stdout) {
        const stdout = createInterface({ input: child.stdout });
        stdout.on("line", (line) => this.handleLine(line));
      }

      if (child.stderr) {
        const stderrLines = createInterface({ input: child.stderr });
        stderrLines.on("line", (line) => {
          if (!line.trim()) return;
          stderr += line + "\n";
          this.emit("event", { type: "log", message: line } satisfies BridgeEvent);
        });
      }

      child.on("error", (error) => {
        this.emit("event", {
          type: "error",
          message: `Failed to start opencode: ${error.message}`,
        } satisfies BridgeEvent);
        finish(1);
      });

      child.on("exit", (code) => {
        if (code !== 0 && stderr.trim()) {
          this.emit("event", {
            type: "error",
            message: stderr.trim().split("\n").slice(-8).join("\n"),
          } satisfies BridgeEvent);
        }
        finish(code);
      });
    });
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      this.emit("event", { type: "log", message: trimmed } satisfies BridgeEvent);
      return;
    }

    const event = asRecord(parsed);
    if (!event) return;

    const sessionId = stringValue(event.sessionID);
    if (sessionId) this.session = sessionId;

    const type = stringValue(event.type);
    const part = asRecord(event.part);

    if (type === "text" && part) {
      const text = stringValue(part.text);
      if (text !== undefined) {
        const clean = text.replace(/^\n+/, "").trimEnd();
        if (clean.trim()) {
          this.emit("event", { type: "text", text: clean } satisfies BridgeEvent);
        }
      }
      return;
    }

    if (type === "tool_use" && part) {
      const tool = stringValue(part.tool) ?? "tool";
      const state = asRecord(part.state);
      const input = state?.input ?? null;
      const output = stringValue(state?.output);
      this.emit("event", {
        type: "tool",
        tool,
        input,
        output,
      } satisfies BridgeEvent);
      return;
    }

    if (type === "step_finish" && part) {
      this.emit("event", {
        type: "step",
        reason: stringValue(part.reason),
        cost: typeof part.cost === "number" ? part.cost : undefined,
      } satisfies BridgeEvent);
      return;
    }

    if (type === "error") {
      const message =
        stringValue(event.message) ??
        stringValue(part?.message) ??
        "OpenCode reported an error";
      this.emit("event", { type: "error", message } satisfies BridgeEvent);
    }
  }
}
