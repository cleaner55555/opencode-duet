import { createHash } from "node:crypto";

export type Role = "host" | "guest";

export interface User {
  name: string;
  role: Role;
}

export interface ChannelInfo {
  id: string;
  name: string;
  sessionId: string;
  createdAt: number;
  createdBy: string;
  description?: string;
  archived: boolean;
  messageCount?: number;
}

export interface HistoryEntry {
  kind: "chat" | "prompt" | "assistant";
  user: string;
  text: string;
  source?: Role | "opencode";
  timestamp: number;
}

export interface BaseMessage {
  type: string;
  timestamp: number;
}

export type ClientMessage =
  | (BaseMessage & { type: "join"; user: string; passwordHash: string })
  | (BaseMessage & { type: "chat"; text: string })
  | (BaseMessage & { type: "prompt"; id: string; text: string })
  | (BaseMessage & {
      type: "approval_response";
      promptId: string;
      approved: boolean;
    })
  | (BaseMessage & { type: "switch_channel"; channel: string })
  | (BaseMessage & {
      type: "create_channel";
      name: string;
      description?: string;
    })
  | (BaseMessage & { type: "archive_channel"; channel: string })
  | (BaseMessage & { type: "channels_request" })
  | (BaseMessage & { type: "memory_request" })
  | (BaseMessage & { type: "memory_add"; text: string })
  | (BaseMessage & { type: "typing"; isTyping: boolean });

export type ServerMessage =
  | (BaseMessage & {
      type: "join_accepted";
      sessionId: string;
      hostUser: string;
      approvalMode: boolean;
      channels: ChannelInfo[];
      activeChannel: string;
    })
  | (BaseMessage & { type: "join_rejected"; reason: string })
  | (BaseMessage & { type: "presence"; users: User[] })
  | (BaseMessage & {
      type: "channels";
      channels: ChannelInfo[];
      active: string;
    })
  | (BaseMessage & {
      type: "channel_switched";
      channel: ChannelInfo;
      active: string;
    })
  | (BaseMessage & {
      type: "channel_history";
      channel: ChannelInfo;
      entries: HistoryEntry[];
    })
  | (BaseMessage & { type: "memory"; text: string })
  | (BaseMessage & {
      type: "chat";
      user: string;
      text: string;
      source: Role;
      channelId?: string;
      channelName?: string;
    })
  | (BaseMessage & {
      type: "prompt_received";
      promptId: string;
      user: string;
      text: string;
      channelId?: string;
      channelName?: string;
    })
  | (BaseMessage & {
      type: "approval_request";
      promptId: string;
      user: string;
      text: string;
      channelId?: string;
      channelName?: string;
    })
  | (BaseMessage & {
      type: "stream";
      text: string;
      channelId?: string;
      channelName?: string;
    })
  | (BaseMessage & {
      type: "tool";
      tool: string;
      input: unknown;
      output?: string;
      channelId?: string;
      channelName?: string;
    })
  | (BaseMessage & {
      type: "turn_complete";
      durationMs: number;
      cost?: number;
      channelId?: string;
      channelName?: string;
    })
  | (BaseMessage & { type: "notice"; message: string })
  | (BaseMessage & {
      type: "error";
      message: string;
      channelId?: string;
      channelName?: string;
    })
  | (BaseMessage & {
      type: "typing";
      user: string;
      isTyping: boolean;
    });

export function hashPassword(password: string): string {
  return createHash("sha256").update(password).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function parseClientMessage(raw: string): ClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(parsed) || !isString(parsed.type)) return null;
  const timestamp = typeof parsed.timestamp === "number" ? parsed.timestamp : Date.now();

  switch (parsed.type) {
    case "join":
      if (!isString(parsed.user) || !isString(parsed.passwordHash)) return null;
      return {
        type: "join",
        user: parsed.user.slice(0, 64),
        passwordHash: parsed.passwordHash,
        timestamp,
      };

    case "chat":
      if (!isString(parsed.text)) return null;
      return { type: "chat", text: parsed.text.slice(0, 20_000), timestamp };

    case "prompt":
      if (!isString(parsed.id) || !isString(parsed.text)) return null;
      return {
        type: "prompt",
        id: parsed.id,
        text: parsed.text.slice(0, 100_000),
        timestamp,
      };

    case "approval_response":
      if (!isString(parsed.promptId) || typeof parsed.approved !== "boolean") {
        return null;
      }
      return {
        type: "approval_response",
        promptId: parsed.promptId,
        approved: parsed.approved,
        timestamp,
      };

    case "switch_channel":
      if (!isString(parsed.channel)) return null;
      return {
        type: "switch_channel",
        channel: parsed.channel.slice(0, 64),
        timestamp,
      };

    case "create_channel":
      if (!isString(parsed.name)) return null;
      return {
        type: "create_channel",
        name: parsed.name.slice(0, 64),
        description: isString(parsed.description)
          ? parsed.description.slice(0, 200)
          : undefined,
        timestamp,
      };

    case "archive_channel":
      if (!isString(parsed.channel)) return null;
      return {
        type: "archive_channel",
        channel: parsed.channel.slice(0, 64),
        timestamp,
      };

    case "channels_request":
      return { type: "channels_request", timestamp };

    case "memory_request":
      return { type: "memory_request", timestamp };

    case "memory_add":
      if (!isString(parsed.text)) return null;
      return {
        type: "memory_add",
        text: parsed.text.slice(0, 4000),
        timestamp,
      };

    case "typing":
      if (typeof parsed.isTyping !== "boolean") return null;
      return {
        type: "typing",
        isTyping: parsed.isTyping,
        timestamp,
      };

    default:
      return null;
  }
}
