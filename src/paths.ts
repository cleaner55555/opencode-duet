import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();

export const CONFIG_DIR =
  process.env.OPENCODE_DUET_CONFIG_DIR ??
  path.join(HOME, ".config", "opencode-duet");

export const STATE_DIR =
  process.env.OPENCODE_DUET_STATE_DIR ??
  path.join(HOME, ".local", "state", "opencode-duet");

export const CONFIG_FILE = path.join(CONFIG_DIR, "agent.json");
export const APPROVALS_FILE = path.join(STATE_DIR, "approvals.json");
export const STATE_FILE = path.join(STATE_DIR, "state.json");
export const BRIEFS_DIR = path.join(STATE_DIR, "briefs");
export const LOGS_DIR = path.join(STATE_DIR, "logs");
export const LOG_FILE = path.join(LOGS_DIR, "agent.log");
export const WORKSPACES_DIR = path.join(STATE_DIR, "workspaces");

export function ensureDirs(): void {
  for (const dir of [CONFIG_DIR, STATE_DIR, BRIEFS_DIR, LOGS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function timestampSlug(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

export function expandHome(input: string): string {
  if (input === "~") return HOME;
  if (input.startsWith("~/")) return path.join(HOME, input.slice(2));
  return input;
}

export function workspaceDir(baseSessionId: string): string {
  const safe =
    baseSessionId.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "default";
  return path.join(WORKSPACES_DIR, safe);
}

export function workspaceFile(baseSessionId: string, file: string): string {
  return path.join(workspaceDir(baseSessionId), file);
}
