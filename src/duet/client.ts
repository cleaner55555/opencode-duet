import { EventEmitter } from "node:events";
import WebSocket from "ws";
import {
  hashPassword,
  type ClientMessage,
  type ServerMessage,
} from "./protocol.js";

export interface JoinResult {
  sessionId: string;
  hostUser: string;
  approvalMode: boolean;
}

export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("http://")) return "ws://" + trimmed.slice(7);
  if (trimmed.startsWith("https://")) return "wss://" + trimmed.slice(8);
  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) return trimmed;
  return "ws://" + trimmed;
}

export class DuetClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private user: string;
  private password: string;

  constructor(user: string, password: string) {
    super();
    this.user = user;
    this.password = password;
  }

  async connect(url: string, timeoutMs = 10_000): Promise<JoinResult> {
    const target = normalizeUrl(url);

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.ws?.close();
        reject(new Error("Connection timed out — wrong password or host unreachable"));
      }, timeoutMs);

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const ws = new WebSocket(target);
      this.ws = ws;

      ws.on("open", () => {
        const join: ClientMessage = {
          type: "join",
          user: this.user,
          passwordHash: hashPassword(this.password),
          timestamp: Date.now(),
        };
        ws.send(JSON.stringify(join));
      });

      ws.on("message", (raw) => {
        let message: ServerMessage;
        try {
          message = JSON.parse(raw.toString()) as ServerMessage;
        } catch {
          return;
        }

        if (message.type === "join_accepted") {
          finish(() =>
            resolve({
              sessionId: message.sessionId,
              hostUser: message.hostUser,
              approvalMode: message.approvalMode,
            }),
          );
          this.emit("message", message);
          return;
        }

        if (message.type === "join_rejected") {
          finish(() => reject(new Error(message.reason)));
          return;
        }

        this.emit("message", message);
      });

      ws.on("error", (error) => {
        finish(() => reject(error));
      });

      ws.on("close", () => {
        this.emit("disconnected");
        if (!settled) {
          finish(() => reject(new Error("Connection closed before joining")));
        }
      });
    });
  }

  sendChat(text: string): void {
    this.send({ type: "chat", text, timestamp: Date.now() });
  }

  sendPrompt(text: string): void {
    this.send({
      type: "prompt",
      id: `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text,
      timestamp: Date.now(),
    });
  }

  sendApproval(promptId: string, approved: boolean): void {
    this.send({
      type: "approval_response",
      promptId,
      approved,
      timestamp: Date.now(),
    });
  }

  sendTyping(isTyping: boolean): void {
    this.send({ type: "typing", isTyping, timestamp: Date.now() });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  private send(message: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }
}
