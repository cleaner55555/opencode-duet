import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface MemoryEntry {
  id: string;
  at: number;
  kind: "note" | "turn";
  channel: string;
  user: string;
  text: string;
}

interface MemoryFile {
  version: number;
  entries: MemoryEntry[];
}

const MAX_NOTE_CHARS = 2000;
const MAX_TURN_CHARS = 900;
const MAX_CONTEXT_CHARS = 3000;

function stamp(at: number): string {
  return new Date(at).toLocaleString();
}

function isEntry(value: unknown): value is MemoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    typeof entry.at === "number" &&
    (entry.kind === "note" || entry.kind === "turn") &&
    typeof entry.channel === "string" &&
    typeof entry.user === "string" &&
    typeof entry.text === "string"
  );
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Memory shared by all channels of a Duet workspace. It stores explicit notes
 * and short summaries of turns from other channels, so a channel can pick up
 * context without replaying every conversation.
 */
export class SharedMemory {
  private entries: MemoryEntry[] = [];
  private readonly filePath: string | null;
  private readonly maxEntries: number;

  constructor(filePath: string | null, maxEntries = 500) {
    this.filePath = filePath;
    this.maxEntries = maxEntries;
    this.load();
  }

  appendNote(text: string, by: string): MemoryEntry {
    const clean = oneLine(text).slice(0, MAX_NOTE_CHARS);
    if (!clean) throw new Error("memory note is empty");
    const entry: MemoryEntry = {
      id: randomUUID(),
      at: Date.now(),
      kind: "note",
      channel: "*",
      user: by,
      text: clean,
    };
    this.entries.push(entry);
    this.trim();
    this.save();
    return entry;
  }

  recordTurn(input: {
    channel: string;
    user: string;
    prompt: string;
    response: string;
  }): MemoryEntry {
    const prompt = oneLine(input.prompt).slice(0, 500);
    const response = oneLine(input.response).slice(0, 500) || "(no output)";
    const entry: MemoryEntry = {
      id: randomUUID(),
      at: Date.now(),
      kind: "turn",
      channel: input.channel,
      user: input.user,
      text: `${prompt} → ${response}`.slice(0, MAX_TURN_CHARS),
    };
    this.entries.push(entry);
    this.trim();
    this.save();
    return entry;
  }

  read(): string {
    if (this.entries.length === 0) return "";
    const lines = this.entries.map((entry) => {
      const where = entry.kind === "note" ? "[note]" : `[#${entry.channel}]`;
      return `- ${stamp(entry.at)} ${where} ${entry.user}: ${entry.text}`;
    });
    return ["# Shared memory", "", ...lines].join("\n").slice(-20_000);
  }

  contextFor(channel: string, maxChars = MAX_CONTEXT_CHARS): string {
    const notes = this.entries.filter((entry) => entry.kind === "note").slice(-20);
    const turns = this.entries
      .filter((entry) => entry.kind === "turn" && entry.channel !== channel)
      .slice(-80)
      .reverse();

    const selected: MemoryEntry[] = [];
    let size = 0;
    for (const entry of [...notes, ...turns]) {
      const line = this.format(entry);
      if (size + line.length + 1 > maxChars) break;
      selected.push(entry);
      size += line.length + 1;
    }

    selected.sort((a, b) => a.at - b.at);
    return selected.map((entry) => this.format(entry)).join("\n");
  }

  decorate(channel: string, prompt: string, channelCount: number): string {
    const context = this.contextFor(channel);
    const header =
      `[Duet workspace | channel #${channel} | ` +
      `${channelCount} channel${channelCount === 1 ? "" : "s"}]`;
    const block = context
      ? `${header}\n` +
        "Shared memory from other channels and notes (context only):\n" +
        `${context}\n` +
        "[End shared memory]"
      : header;
    return `${block}\n\n${prompt}`;
  }

  clear(): void {
    this.entries = [];
    this.save();
  }

  private format(entry: MemoryEntry): string {
    const where = entry.kind === "note" ? "[note]" : `[#${entry.channel}]`;
    return `- ${stamp(entry.at)} ${where} ${entry.user}: ${entry.text}`;
  }

  private trim(): void {
    while (this.entries.length > this.maxEntries) {
      const turn = this.entries.findIndex((entry) => entry.kind === "turn");
      if (turn === -1) this.entries.shift();
      else this.entries.splice(turn, 1);
    }
  }

  private load(): void {
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.filePath, "utf8"),
      ) as Partial<MemoryFile>;
      if (Array.isArray(parsed.entries)) {
        this.entries = parsed.entries.filter(isEntry).slice(-this.maxEntries);
      }
    } catch {
      this.entries = [];
    }
  }

  private save(): void {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload: MemoryFile = { version: 1, entries: this.entries };
    const temp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(payload, null, 2) + "\n", "utf8");
    fs.renameSync(temp, this.filePath);
  }
}
