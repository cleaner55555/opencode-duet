import fs from "node:fs";
import { CONFIG_FILE, ensureDirs } from "../paths.js";

export interface BriefConfig {
  enabled: boolean;
  at: string;
  prompt: string;
}

export interface CheckConfig {
  name: string;
  every: string;
  prompt: string;
}

export interface SourceConfig {
  name: string;
  command: string;
  timeoutMs?: number;
}

export interface NotifyConfig {
  macos: boolean;
  webhook?: string;
}

export interface ApprovalsConfig {
  enabled: boolean;
}

export interface AgentConfig {
  version: number;
  name: string;
  cwd: string;
  model?: string;
  agent?: string;
  session: string;
  brief: BriefConfig;
  checks: CheckConfig[];
  sources: SourceConfig[];
  notify: NotifyConfig;
  approvals: ApprovalsConfig;
}

export const DEFAULT_CONFIG: AgentConfig = {
  version: 1,
  name: "Duet",
  cwd: "~",
  session: "ses_duet_agent",
  brief: {
    enabled: true,
    at: "08:00",
    prompt:
      "Napravi kratak jutarnji brief na srpskom (latinica). " +
      "Izvuci samo ono što je danas važno: obaveze, rokove, otvorene PR-ove, " +
      "probleme u projektu i sledeću konkretnu akciju. Bez uvoda i bez ponavljanja.",
  },
  checks: [],
  sources: [
    { name: "date", command: "date '+%Y-%m-%d %H:%M %Z'" },
    {
      name: "git",
      command: "git status --short --branch 2>/dev/null || true",
    },
  ],
  notify: { macos: true, webhook: "" },
  approvals: { enabled: true },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function mergeConfig(base: AgentConfig, input: unknown): AgentConfig {
  if (!isRecord(input)) return base;
  const merged: AgentConfig = {
    ...base,
    ...(input as Partial<AgentConfig>),
    brief: {
      ...base.brief,
      ...(isRecord(input.brief) ? (input.brief as Partial<BriefConfig>) : {}),
    },
    notify: {
      ...base.notify,
      ...(isRecord(input.notify) ? (input.notify as Partial<NotifyConfig>) : {}),
    },
    approvals: {
      ...base.approvals,
      ...(isRecord(input.approvals)
        ? (input.approvals as Partial<ApprovalsConfig>)
        : {}),
    },
    checks: Array.isArray(input.checks)
      ? (input.checks as CheckConfig[])
      : base.checks,
    sources: Array.isArray(input.sources)
      ? (input.sources as SourceConfig[])
      : base.sources,
  };
  return merged;
}

export function validateConfig(config: AgentConfig): void {
  if (!config.session || typeof config.session !== "string") {
    throw new Error("config.session must be a non-empty string");
  }
  if (!/^\d{1,2}:\d{2}$/.test(config.brief.at)) {
    throw new Error(`config.brief.at must be HH:MM, got "${config.brief.at}"`);
  }
  const [hour, minute] = config.brief.at.split(":").map(Number);
  if (hour > 23 || minute > 59) {
    throw new Error(`config.brief.at is out of range: ${config.brief.at}`);
  }
  for (const check of config.checks) {
    if (!check.name || !check.prompt) {
      throw new Error("every check needs a name and a prompt");
    }
    if (!/^\d+(s|m|h|d)$/.test(check.every)) {
      throw new Error(
        `check "${check.name}" has invalid every="${check.every}" (use 30m, 2h, 1d)`,
      );
    }
  }
  for (const source of config.sources) {
    if (!source.name || !source.command) {
      throw new Error("every source needs a name and a command");
    }
  }
}

export function loadAgentConfig(path = CONFIG_FILE): AgentConfig {
  ensureDirs();
  if (!fs.existsSync(path)) {
    return structuredClone(DEFAULT_CONFIG);
  }
  const raw = fs.readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${path}: ${message}`);
  }
  const config = mergeConfig(structuredClone(DEFAULT_CONFIG), parsed);
  validateConfig(config);
  return config;
}

export function saveConfig(config: AgentConfig, path = CONFIG_FILE): void {
  ensureDirs();
  fs.writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
}

export function initConfig(path = CONFIG_FILE): AgentConfig {
  if (fs.existsSync(path)) {
    return loadAgentConfig(path);
  }
  const config = structuredClone(DEFAULT_CONFIG);
  saveConfig(config, path);
  return config;
}
