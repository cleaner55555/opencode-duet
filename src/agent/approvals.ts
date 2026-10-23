import { exec as execCallback } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { promisify } from "node:util";
import { APPROVALS_FILE, ensureDirs } from "../paths.js";

const exec = promisify(execCallback);

export type ApprovalType = "shell" | "webhook";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "done" | "failed";

export interface ApprovalInput {
  type: ApprovalType;
  title: string;
  reason?: string;
  command?: string;
  url?: string;
  payload?: unknown;
  cwd?: string;
}

export interface Approval extends ApprovalInput {
  id: string;
  createdAt: string;
  status: ApprovalStatus;
  result?: string;
}

export function formatApproval(approval: Approval): string {
  const lines = [
    `${approval.id}  [${approval.status}]  ${approval.type}  ${approval.title}`,
  ];
  if (approval.reason) lines.push(`  reason: ${approval.reason}`);
  if (approval.command) lines.push(`  command: ${approval.command}`);
  if (approval.url) lines.push(`  url: ${approval.url}`);
  if (approval.result) lines.push(`  result: ${approval.result}`);
  return lines.join("\n");
}

export class ApprovalStore {
  private items: Approval[] = [];

  constructor(private file = APPROVALS_FILE) {
    this.load();
  }

  load(): void {
    ensureDirs();
    if (!fs.existsSync(this.file)) {
      this.items = [];
      return;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.items = Array.isArray(parsed) ? (parsed as Approval[]) : [];
    } catch {
      const backup = `${this.file}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(this.file, backup);
      } catch {
        // ignore
      }
      this.items = [];
    }
  }

  save(): void {
    ensureDirs();
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(this.items, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, this.file);
  }

  list(status?: ApprovalStatus): Approval[] {
    return status
      ? this.items.filter((item) => item.status === status)
      : [...this.items];
  }

  get(idOrPrefix: string): Approval | undefined {
    return this.items.find(
      (item) => item.id === idOrPrefix || item.id.startsWith(idOrPrefix),
    );
  }

  add(input: ApprovalInput): Approval {
    const approval: Approval = {
      ...input,
      id: `ap-${randomBytes(4).toString("hex")}`,
      createdAt: new Date().toISOString(),
      status: "pending",
    };
    this.items.push(approval);
    this.save();
    return approval;
  }

  reject(idOrPrefix: string): Approval {
    const approval = this.get(idOrPrefix);
    if (!approval) throw new Error(`Approval not found: ${idOrPrefix}`);
    if (approval.status !== "pending") {
      throw new Error(`Approval ${approval.id} is already ${approval.status}`);
    }
    approval.status = "rejected";
    this.save();
    return approval;
  }

  async approve(idOrPrefix: string): Promise<Approval> {
    const approval = this.get(idOrPrefix);
    if (!approval) throw new Error(`Approval not found: ${idOrPrefix}`);
    if (approval.status !== "pending") {
      throw new Error(`Approval ${approval.id} is already ${approval.status}`);
    }

    approval.status = "approved";
    this.save();

    try {
      approval.result = await this.execute(approval);
      approval.status = "done";
    } catch (error) {
      approval.result = error instanceof Error ? error.message : String(error);
      approval.status = "failed";
    }
    this.save();
    return approval;
  }

  private async execute(approval: Approval): Promise<string> {
    if (approval.type === "shell") {
      if (!approval.command) throw new Error("shell approval has no command");
      const { stdout, stderr } = await exec(approval.command, {
        cwd: approval.cwd ?? process.cwd(),
        timeout: 120_000,
        maxBuffer: 2 * 1024 * 1024,
        shell: "/bin/bash",
      });
      const output = [stdout, stderr].filter(Boolean).join("\n").trim();
      return output.slice(0, 8000) || "(no output)";
    }

    if (approval.type === "webhook") {
      if (!approval.url) throw new Error("webhook approval has no url");
      const response = await fetch(approval.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          approval.payload ?? {
            title: approval.title,
            reason: approval.reason,
            source: "opencode-duet",
          },
        ),
        signal: AbortSignal.timeout(30_000),
      });
      return `HTTP ${response.status}`;
    }

    throw new Error(`Unknown approval type: ${String(approval.type)}`);
  }
}
