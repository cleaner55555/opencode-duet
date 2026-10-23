import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type {
  AgentBridge,
  BridgeEvent,
  RunPromptOptions,
} from "../opencode.js";
import {
  hashPassword,
  parseClientMessage,
  type ServerMessage,
  type User,
} from "./protocol.js";

export interface DuetServerOptions {
  hostUser: string;
  password: string;
  sessionId: string;
  bridge: AgentBridge;
  approvalMode?: boolean;
  cwd?: string;
  model?: string;
  agent?: string;
  auto?: boolean;
}

export interface PendingPrompt {
  id: string;
  user: string;
  text: string;
  createdAt: number;
}

const MAX_QUEUE = 10;

export class DuetServer extends EventEmitter {
  private wss: WebSocketServer | null = null;
  private guest: WebSocket | null = null;
  private guestUser: string | null = null;
  private readonly options: Required<
    Pick<DuetServerOptions, "hostUser" | "password" | "sessionId" | "bridge">
  > &
    DuetServerOptions;
  private approvalMode: boolean;
  private pending = new Map<string, PendingPrompt>();
  private queue: PendingPrompt[] = [];
  private active: PendingPrompt | null = null;
  private activeStartedAt = 0;
  private stopped = false;
  private onBridgeEvent = (event: BridgeEvent) => this.handleBridgeEvent(event);

  constructor(options: DuetServerOptions) {
    super();
    this.options = options;
    this.approvalMode = options.approvalMode ?? true;
    this.options.bridge.on("event", this.onBridgeEvent);
  }

  get password(): string {
    return this.options.password;
  }

  get sessionId(): string {
    return this.options.sessionId;
  }

  get isApprovalMode(): boolean {
    return this.approvalMode;
  }

  users(): User[] {
    const users: User[] = [{ name: this.options.hostUser, role: "host" }];
    if (this.guestUser) users.push({ name: this.guestUser, role: "guest" });
    return users;
  }

  async start(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ port, host: "0.0.0.0" });
      this.wss = wss;

      wss.once("listening", () => {
        const address = wss.address();
        resolve(typeof address === "object" && address ? address.port : port);
      });
      wss.once("error", reject);
      wss.on("connection", (ws) => this.handleConnection(ws));
    });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.options.bridge.off("event", this.onBridgeEvent);
    this.options.bridge.cancel();
    for (const client of [this.guest]) {
      try {
        client?.close();
      } catch {
        // ignore
      }
    }
    this.guest = null;
    this.guestUser = null;
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
      this.wss = null;
    });
  }

  setApprovalMode(enabled: boolean): void {
    this.approvalMode = enabled;
    this.broadcast({
      type: "notice",
      message: `Approval mode ${enabled ? "ON" : "OFF"}`,
      timestamp: Date.now(),
    });
  }

  hostChat(text: string): void {
    const clean = text.trim();
    if (!clean) return;
    this.broadcast({
      type: "chat",
      user: this.options.hostUser,
      text: clean,
      source: "host",
      timestamp: Date.now(),
    });
  }

  hostPrompt(text: string): void {
    const clean = text.trim();
    if (!clean) return;
    const pending: PendingPrompt = {
      id: randomUUID(),
      user: this.options.hostUser,
      text: clean,
      createdAt: Date.now(),
    };
    this.enqueue(pending);
  }

  approve(promptId: string, approved: boolean): void {
    let key = promptId;
    if (!this.pending.has(key)) {
      const match = [...this.pending.keys()].find((id) => id.startsWith(promptId));
      if (match) key = match;
    }
    const pending = this.pending.get(key);
    if (!pending) {
      this.emit("message", {
        type: "error",
        message: `Unknown approval request: ${promptId}`,
        timestamp: Date.now(),
      } satisfies ServerMessage);
      return;
    }

    this.pending.delete(key);
    if (!approved) {
      this.sendGuest({
        type: "notice",
        message: `Host denied ${pending.user}'s prompt.`,
        timestamp: Date.now(),
      });
      this.emit("message", {
        type: "notice",
        message: `Denied prompt ${promptId.slice(0, 8)}.`,
        timestamp: Date.now(),
      } satisfies ServerMessage);
      return;
    }

    this.enqueue(pending);
  }

  private handleConnection(ws: WebSocket): void {
    let joined = false;

    ws.on("message", (raw) => {
      const message = parseClientMessage(raw.toString());
      if (!message) return;

      if (message.type === "join") {
        if (this.guest) {
          this.send(ws, {
            type: "join_rejected",
            reason: "Session is full",
            timestamp: Date.now(),
          });
          ws.close();
          return;
        }
        if (message.passwordHash !== hashPassword(this.options.password)) {
          this.send(ws, {
            type: "join_rejected",
            reason: "Invalid password",
            timestamp: Date.now(),
          });
          ws.close();
          return;
        }

        joined = true;
        this.guest = ws;
        this.guestUser = message.user;
        this.send(ws, {
          type: "join_accepted",
          sessionId: this.options.sessionId,
          hostUser: this.options.hostUser,
          approvalMode: this.approvalMode,
          timestamp: Date.now(),
        });
        this.sendPresence();
        this.emit("guest_joined", message.user);
        this.emit("message", {
          type: "notice",
          message: `${message.user} joined the duet.`,
          timestamp: Date.now(),
        } satisfies ServerMessage);
        return;
      }

      if (!joined) return;

      switch (message.type) {
        case "chat":
          this.broadcast({
            type: "chat",
            user: this.guestUser ?? "guest",
            text: message.text,
            source: "guest",
            timestamp: Date.now(),
          });
          break;

        case "prompt": {
          const pending: PendingPrompt = {
            id: message.id,
            user: this.guestUser ?? "guest",
            text: message.text,
            createdAt: Date.now(),
          };
          if (this.approvalMode) {
            this.pending.set(pending.id, pending);
            this.emit("approval_request", pending);
            this.sendGuest({
              type: "notice",
              message: "Waiting for the host to approve your prompt…",
              timestamp: Date.now(),
            });
          } else {
            this.enqueue(pending);
          }
          break;
        }

        case "approval_response":
          this.approve(message.promptId, message.approved);
          break;

        case "typing":
          this.sendGuest({
            type: "typing",
            user: this.guestUser ?? "guest",
            isTyping: message.isTyping,
            timestamp: Date.now(),
          });
          this.emit("message", {
            type: "typing",
            user: this.guestUser ?? "guest",
            isTyping: message.isTyping,
            timestamp: Date.now(),
          } satisfies ServerMessage);
          break;
      }
    });

    ws.on("close", () => {
      if (ws === this.guest) {
        const name = this.guestUser;
        this.guest = null;
        this.guestUser = null;
        this.sendPresence();
        if (name) {
          this.emit("guest_left", name);
          this.emit("message", {
            type: "notice",
            message: `${name} left the duet.`,
            timestamp: Date.now(),
          } satisfies ServerMessage);
        }
      }
    });

    ws.on("error", () => {
      // The close handler cleans up.
    });
  }

  private enqueue(pending: PendingPrompt): void {
    if (this.queue.length >= MAX_QUEUE) {
      this.emit("message", {
        type: "error",
        message: "Prompt queue is full; wait for OpenCode to finish.",
        timestamp: Date.now(),
      } satisfies ServerMessage);
      return;
    }
    this.queue.push(pending);
    this.processQueue();
  }

  private processQueue(): void {
    if (this.active || this.queue.length === 0) return;
    const pending = this.queue.shift()!;
    this.active = pending;
    this.activeStartedAt = Date.now();

    this.broadcast({
      type: "prompt_received",
      promptId: pending.id,
      user: pending.user,
      text: pending.text,
      timestamp: Date.now(),
    });

    const options: RunPromptOptions = {
      prompt: pending.text,
      sessionId: this.options.sessionId,
      cwd: this.options.cwd,
      model: this.options.model,
      agent: this.options.agent,
      auto: this.options.auto,
    };

    this.options.bridge.run(options).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.broadcast({
        type: "error",
        message,
        timestamp: Date.now(),
      });
      this.finishActive();
    });
  }

  private handleBridgeEvent(event: BridgeEvent): void {
    switch (event.type) {
      case "text":
        this.broadcast({
          type: "stream",
          text: event.text,
          timestamp: Date.now(),
        });
        break;

      case "tool":
        this.broadcast({
          type: "tool",
          tool: event.tool,
          input: event.input,
          output: event.output,
          timestamp: Date.now(),
        });
        break;

      case "error":
        this.broadcast({
          type: "error",
          message: event.message,
          timestamp: Date.now(),
        });
        break;

      case "done":
        this.broadcast({
          type: "turn_complete",
          durationMs: this.activeStartedAt ? Date.now() - this.activeStartedAt : 0,
          timestamp: Date.now(),
        });
        this.finishActive();
        break;

      case "log":
        this.emit("log", event.message);
        break;

      case "step":
        break;
    }
  }

  private finishActive(): void {
    this.active = null;
    this.activeStartedAt = 0;
    this.processQueue();
  }

  private sendPresence(): void {
    const users = this.users();
    if (this.guest) {
      this.send(this.guest, {
        type: "presence",
        users,
        timestamp: Date.now(),
      });
    }
    this.emit("message", {
      type: "presence",
      users,
      timestamp: Date.now(),
    } satisfies ServerMessage);
  }

  private broadcast(message: ServerMessage): void {
    if (this.guest) this.send(this.guest, message);
    this.emit("message", message);
  }

  private sendGuest(message: ServerMessage): void {
    if (this.guest) this.send(this.guest, message);
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }
}
