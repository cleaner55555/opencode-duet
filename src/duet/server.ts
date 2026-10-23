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
  type ChannelInfo,
  type HistoryEntry,
  type Role,
  type ServerMessage,
  type User,
} from "./protocol.js";
import { ChannelStore, type Channel } from "./channels.js";
import { SharedMemory } from "./memory.js";
import { LocalSessionCreator, type SessionCreator } from "./sessions.js";

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
  channels?: ChannelStore;
  memory?: SharedMemory;
  sessions?: SessionCreator;
}

export interface PendingPrompt {
  id: string;
  user: string;
  text: string;
  createdAt: number;
  channelId: string;
}

const MAX_QUEUE = 10;
const MAX_HISTORY = 100;

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
  private activeChannelId: string | null = null;
  private activeResponse = "";
  private stopped = false;
  private readonly channels: ChannelStore;
  private readonly memory: SharedMemory;
  private readonly sessions: SessionCreator;
  private hostChannelId = "main";
  private guestChannelId = "main";
  private history = new Map<string, HistoryEntry[]>();
  private onBridgeEvent = (event: BridgeEvent) => this.handleBridgeEvent(event);

  constructor(options: DuetServerOptions) {
    super();
    this.options = options;
    this.approvalMode = options.approvalMode ?? true;
    this.channels =
      options.channels ?? new ChannelStore(null, options.sessionId);
    this.memory = options.memory ?? new SharedMemory(null);
    this.sessions = options.sessions ?? new LocalSessionCreator();
    this.hostChannelId = this.channels.main.id;
    this.guestChannelId = this.channels.main.id;
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
    const channel = this.activeChannel("host");
    const timestamp = Date.now();
    this.recordHistory(channel.id, {
      kind: "chat",
      user: this.options.hostUser,
      text: clean,
      source: "host",
      timestamp,
    });
    this.broadcast({
      type: "chat",
      user: this.options.hostUser,
      text: clean,
      source: "host",
      channelId: channel.id,
      channelName: channel.name,
      timestamp,
    });
  }

  hostPrompt(text: string): void {
    const clean = text.trim();
    if (!clean) return;
    const channel = this.activeChannel("host");
    const pending: PendingPrompt = {
      id: randomUUID(),
      user: this.options.hostUser,
      text: clean,
      createdAt: Date.now(),
      channelId: channel.id,
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

  sendChannels(role: Role): void {
    this.sendToRole(role, this.channelsMessage(role));
  }

  switchChannel(role: Role, ref: string): void {
    const channel = this.channels.get(ref);
    if (!channel) {
      this.sendError(role, `unknown channel: ${ref}`);
      return;
    }
    if (channel.archived) {
      this.sendError(role, `channel #${channel.name} is archived`);
      return;
    }

    if (role === "host") this.hostChannelId = channel.id;
    else this.guestChannelId = channel.id;

    this.sendToRole(role, {
      type: "channel_switched",
      channel: this.channelInfo(channel),
      active: channel.id,
      timestamp: Date.now(),
    });
    this.sendHistory(role, channel);
    this.sendChannels(role);
  }

  async createChannel(
    role: Role,
    name: string,
    description?: string,
  ): Promise<void> {
    const by =
      role === "host" ? this.options.hostUser : this.guestUser ?? "guest";
    let display: string;
    try {
      display = this.channels.assertAvailable(name);
    } catch (error) {
      this.sendError(role, error instanceof Error ? error.message : String(error));
      return;
    }

    let sessionId: string | undefined;
    try {
      sessionId = await this.sessions.createChild(
        this.options.sessionId,
        `#${display}`,
        this.options.cwd,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit("log", `channel #${display}: ${message}`);
      this.sendToRole(role, {
        type: "notice",
        message:
          `Could not create an OpenCode child session for #${display}; ` +
          "using a standalone session instead.",
        timestamp: Date.now(),
      });
    }

    let channel: Channel;
    try {
      channel = this.channels.create(display, by, description, sessionId);
    } catch (error) {
      if (sessionId) void this.sessions.remove(sessionId);
      this.sendError(role, error instanceof Error ? error.message : String(error));
      return;
    }

    this.history.set(channel.id, []);
    this.switchChannel(role, channel.id);
    this.sendChannels(this.otherRole(role));
    this.broadcast({
      type: "notice",
      message: `${by} created #${channel.name}.`,
      timestamp: Date.now(),
    });
  }

  archiveChannel(role: Role, ref: string): void {
    if (role !== "host") {
      this.sendError(role, "only the host can archive channels");
      return;
    }
    const channel = this.channels.get(ref);
    if (!channel) {
      this.sendError(role, `unknown channel: ${ref}`);
      return;
    }
    if (channel.id === "main") {
      this.sendError(role, "the main channel cannot be archived");
      return;
    }
    if (channel.archived) {
      this.sendError(role, `channel #${channel.name} is already archived`);
      return;
    }

    this.channels.archive(channel.id);
    if (this.hostChannelId === channel.id) this.switchChannel("host", "main");
    if (this.guestChannelId === channel.id) this.switchChannel("guest", "main");
    this.broadcastChannels();
    this.broadcast({
      type: "notice",
      message: `${this.options.hostUser} archived #${channel.name}.`,
      timestamp: Date.now(),
    });
  }

  sendMemory(role: Role): void {
    const text = this.memory.read();
    this.sendToRole(role, {
      type: "memory",
      text: text || "(shared memory is empty)",
      timestamp: Date.now(),
    });
  }

  addMemory(role: Role, text: string): void {
    const clean = text.trim();
    if (!clean) return;
    const by =
      role === "host" ? this.options.hostUser : this.guestUser ?? "guest";
    try {
      this.memory.appendNote(clean, by);
    } catch (error) {
      this.sendError(role, error instanceof Error ? error.message : String(error));
      return;
    }
    this.broadcast({
      type: "notice",
      message: `${by} added a note to shared memory.`,
      timestamp: Date.now(),
    });
    this.sendMemory(role);
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
        this.guestChannelId = this.channels.main.id;
        this.send(ws, {
          type: "join_accepted",
          sessionId: this.options.sessionId,
          hostUser: this.options.hostUser,
          approvalMode: this.approvalMode,
          channels: this.channelList(),
          activeChannel: this.guestChannelId,
          timestamp: Date.now(),
        });
        this.sendPresence();
        this.sendHistory("guest", this.activeChannel("guest"));
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
        case "chat": {
          const channel = this.activeChannel("guest");
          const timestamp = Date.now();
          this.recordHistory(channel.id, {
            kind: "chat",
            user: this.guestUser ?? "guest",
            text: message.text,
            source: "guest",
            timestamp,
          });
          this.broadcast({
            type: "chat",
            user: this.guestUser ?? "guest",
            text: message.text,
            source: "guest",
            channelId: channel.id,
            channelName: channel.name,
            timestamp,
          });
          break;
        }

        case "prompt": {
          const channel = this.activeChannel("guest");
          const pending: PendingPrompt = {
            id: message.id,
            user: this.guestUser ?? "guest",
            text: message.text,
            createdAt: Date.now(),
            channelId: channel.id,
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

        case "switch_channel":
          this.switchChannel("guest", message.channel);
          break;

        case "create_channel":
          void this.createChannel("guest", message.name, message.description);
          break;

        case "archive_channel":
          this.archiveChannel("guest", message.channel);
          break;

        case "channels_request":
          this.sendChannels("guest");
          break;

        case "memory_request":
          this.sendMemory("guest");
          break;

        case "memory_add":
          this.addMemory("guest", message.text);
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
        this.guestChannelId = this.channels.main.id;
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
    this.activeChannelId = pending.channelId;
    this.activeResponse = "";

    const channel =
      this.channels.get(pending.channelId) ?? this.channels.main;
    this.activeChannelId = channel.id;

    const timestamp = Date.now();
    this.broadcast({
      type: "prompt_received",
      promptId: pending.id,
      user: pending.user,
      text: pending.text,
      channelId: channel.id,
      channelName: channel.name,
      timestamp,
    });
    this.recordHistory(channel.id, {
      kind: "prompt",
      user: pending.user,
      text: pending.text,
      source: pending.user === this.options.hostUser ? "host" : "guest",
      timestamp,
    });

    const options: RunPromptOptions = {
      prompt: this.memory.decorate(
        channel.name,
        pending.text,
        this.channels.list().length,
      ),
      sessionId: channel.sessionId,
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
        channelId: channel.id,
        channelName: channel.name,
        timestamp: Date.now(),
      });
      this.finishActive();
    });
  }

  private handleBridgeEvent(event: BridgeEvent): void {
    const channel = this.activeChannelId
      ? this.channels.get(this.activeChannelId)
      : null;

    switch (event.type) {
      case "text":
        this.activeResponse += (this.activeResponse ? "\n\n" : "") + event.text;
        this.broadcast({
          type: "stream",
          text: event.text,
          channelId: channel?.id,
          channelName: channel?.name,
          timestamp: Date.now(),
        });
        break;

      case "tool":
        this.broadcast({
          type: "tool",
          tool: event.tool,
          input: event.input,
          output: event.output,
          channelId: channel?.id,
          channelName: channel?.name,
          timestamp: Date.now(),
        });
        break;

      case "error":
        this.broadcast({
          type: "error",
          message: event.message,
          channelId: channel?.id,
          channelName: channel?.name,
          timestamp: Date.now(),
        });
        break;

      case "done": {
        const active = this.active;
        if (channel && active) {
          const response = this.activeResponse.trim();
          this.memory.recordTurn({
            channel: channel.name,
            user: active.user,
            prompt: active.text,
            response,
          });
          this.recordHistory(channel.id, {
            kind: "assistant",
            user: "opencode",
            text: response || "(no output)",
            source: "opencode",
            timestamp: Date.now(),
          });
        }
        this.broadcast({
          type: "turn_complete",
          durationMs: this.activeStartedAt ? Date.now() - this.activeStartedAt : 0,
          channelId: channel?.id,
          channelName: channel?.name,
          timestamp: Date.now(),
        });
        this.activeResponse = "";
        this.activeChannelId = null;
        this.finishActive();
        break;
      }

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
    this.activeChannelId = null;
    this.processQueue();
  }

  private activeChannel(role: Role): Channel {
    const id = role === "host" ? this.hostChannelId : this.guestChannelId;
    return this.channels.get(id) ?? this.channels.main;
  }

  private otherRole(role: Role): Role {
    return role === "host" ? "guest" : "host";
  }

  private channelInfo(channel: Channel): ChannelInfo {
    return {
      ...channel,
      messageCount: this.history.get(channel.id)?.length ?? 0,
    };
  }

  private channelList(): ChannelInfo[] {
    return this.channels.list().map((channel) => this.channelInfo(channel));
  }

  private channelsMessage(role: Role): ServerMessage {
    return {
      type: "channels",
      channels: this.channelList(),
      active: role === "host" ? this.hostChannelId : this.guestChannelId,
      timestamp: Date.now(),
    };
  }

  private sendHistory(role: Role, channel: Channel): void {
    this.sendToRole(role, {
      type: "channel_history",
      channel: this.channelInfo(channel),
      entries: [...(this.history.get(channel.id) ?? [])].slice(-40),
      timestamp: Date.now(),
    });
  }

  private recordHistory(channelId: string, entry: HistoryEntry): void {
    const entries = this.history.get(channelId) ?? [];
    entries.push(entry);
    if (entries.length > MAX_HISTORY) {
      entries.splice(0, entries.length - MAX_HISTORY);
    }
    this.history.set(channelId, entries);
  }

  private sendError(role: Role, message: string): void {
    this.sendToRole(role, {
      type: "error",
      message,
      timestamp: Date.now(),
    });
  }

  private sendToRole(role: Role, message: ServerMessage): void {
    if (role === "host") this.emit("message", message);
    else this.sendGuest(message);
  }

  private broadcastChannels(): void {
    this.sendChannels("host");
    this.sendChannels("guest");
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
