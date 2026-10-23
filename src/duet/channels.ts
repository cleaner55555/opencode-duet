import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface Channel {
  id: string;
  name: string;
  sessionId: string;
  createdAt: number;
  createdBy: string;
  description?: string;
  archived: boolean;
}

interface ChannelFile {
  version: number;
  baseSessionId: string;
  channels: Channel[];
}

export function slugifyChannel(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "channel"
  );
}

export function makeChannelSessionId(id: string): string {
  const clean = id.replace(/[^a-z0-9]/g, "").slice(0, 24) || "ch";
  return `ses_duet_${clean}_${randomBytes(4).toString("hex")}`;
}

function isChannel(value: unknown): value is Channel {
  if (typeof value !== "object" || value === null) return false;
  const channel = value as Record<string, unknown>;
  return (
    typeof channel.id === "string" &&
    typeof channel.name === "string" &&
    typeof channel.sessionId === "string" &&
    typeof channel.createdAt === "number" &&
    typeof channel.createdBy === "string" &&
    typeof channel.archived === "boolean"
  );
}

/**
 * Channels are named sub-threads of one Duet workspace. Every channel has its
 * own OpenCode session, while notes and cross-channel activity live in
 * SharedMemory.
 */
export class ChannelStore {
  private channels: Channel[] = [];
  private readonly filePath: string | null;
  readonly baseSessionId: string;

  constructor(filePath: string | null, baseSessionId: string) {
    this.filePath = filePath;
    this.baseSessionId = baseSessionId;
    this.load();
  }

  get main(): Channel {
    return this.channels.find((channel) => channel.id === "main")!;
  }

  list(includeArchived = false): Channel[] {
    return this.channels.filter(
      (channel) => includeArchived || !channel.archived,
    );
  }

  get(ref: string): Channel | undefined {
    const clean = ref.trim().replace(/^#/, "").toLowerCase();
    if (!clean) return undefined;
    return this.channels.find(
      (channel) =>
        channel.id.toLowerCase() === clean ||
        channel.name.toLowerCase() === clean,
    );
  }

  /**
   * Validate a requested channel name and return the display form. Callers can
   * use this before creating an OpenCode child session, so a duplicate name
   * does not leave an orphan session behind.
   */
  assertAvailable(name: string): string {
    const display = name.trim().replace(/^#/, "").slice(0, 48);
    if (!display) throw new Error("channel name is required");
    if (
      this.channels.some(
        (channel) => channel.name.toLowerCase() === display.toLowerCase(),
      )
    ) {
      throw new Error(`channel #${display} already exists`);
    }
    return display;
  }

  create(
    name: string,
    createdBy: string,
    description?: string,
    sessionId?: string,
  ): Channel {
    const display = this.assertAvailable(name);

    let id = slugifyChannel(display);
    let suffix = 2;
    while (this.channels.some((channel) => channel.id === id)) {
      id = `${slugifyChannel(display)}-${suffix++}`;
    }

    const channelSession = sessionId?.trim();
    if (channelSession !== undefined && !channelSession.startsWith("ses_")) {
      throw new Error(`invalid OpenCode session id: ${sessionId}`);
    }

    const channel: Channel = {
      id,
      name: display,
      sessionId: channelSession || makeChannelSessionId(id),
      createdAt: Date.now(),
      createdBy,
      archived: false,
    };
    if (description?.trim()) channel.description = description.trim().slice(0, 200);
    this.channels.push(channel);
    this.save();
    return channel;
  }

  archive(ref: string): Channel {
    const channel = this.get(ref);
    if (!channel) throw new Error(`unknown channel: ${ref}`);
    if (channel.id === "main") throw new Error("the main channel cannot be archived");
    if (channel.archived) throw new Error(`channel #${channel.name} is already archived`);
    channel.archived = true;
    this.save();
    return channel;
  }

  private load(): void {
    if (this.filePath && fs.existsSync(this.filePath)) {
      try {
        const parsed = JSON.parse(
          fs.readFileSync(this.filePath, "utf8"),
        ) as Partial<ChannelFile>;
        if (Array.isArray(parsed.channels)) {
          this.channels = parsed.channels.filter(isChannel);
        }
      } catch {
        // A corrupt channel file should not prevent the session from starting.
        this.channels = [];
      }
    }

    if (!this.channels.some((channel) => channel.id === "main")) {
      this.channels.unshift({
        id: "main",
        name: "main",
        sessionId: this.baseSessionId,
        createdAt: Date.now(),
        createdBy: "host",
        archived: false,
      });
    }
  }

  private save(): void {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload: ChannelFile = {
      version: 1,
      baseSessionId: this.baseSessionId,
      channels: this.channels,
    };
    const temp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(payload, null, 2) + "\n", "utf8");
    fs.renameSync(temp, this.filePath);
  }
}
