import type { AgentConfig, CheckConfig } from "./config.js";

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const MAX_TIMEOUT = 2_147_483_647;

export function parseDuration(input: string): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(input.trim());
  if (!match) {
    throw new Error(`Invalid duration "${input}" (use 30m, 2h, 1d)`);
  }
  return Number(match[1]) * UNIT_MS[match[2]];
}

export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

export function parseAt(input: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(input.trim());
  if (!match) throw new Error(`Invalid time "${input}" (use HH:MM)`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`Time out of range: ${input}`);
  return { hour, minute };
}

export function nextDailyRun(at: string, now = new Date()): Date {
  const { hour, minute } = parseAt(at);
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

export interface SchedulerHandlers {
  onBrief: () => Promise<void>;
  onCheck: (check: CheckConfig) => Promise<void>;
  onLog?: (message: string) => void;
  onError?: (error: unknown) => void;
}

export class Scheduler {
  private timers = new Set<NodeJS.Timeout>();
  private stopped = false;
  private briefRunning = false;
  private checksRunning = new Set<string>();

  constructor(
    private config: AgentConfig,
    private handlers: SchedulerHandlers,
  ) {}

  start(): void {
    this.stopped = false;
    if (this.config.brief.enabled) this.scheduleBrief();
    for (const check of this.config.checks) this.scheduleCheck(check);
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  nextBriefAt(now = new Date()): Date | null {
    if (!this.config.brief.enabled) return null;
    return nextDailyRun(this.config.brief.at, now);
  }

  status(now = new Date()): string {
    const lines: string[] = [];
    const nextBrief = this.nextBriefAt(now);
    if (nextBrief) {
      lines.push(`brief: ${this.config.brief.at} (next ${nextBrief.toLocaleString()})`);
    } else {
      lines.push("brief: disabled");
    }
    if (this.config.checks.length === 0) {
      lines.push("checks: none");
    } else {
      for (const check of this.config.checks) {
        lines.push(`check ${check.name}: every ${check.every}`);
      }
    }
    return lines.join("\n");
  }

  async runBriefNow(): Promise<void> {
    if (this.briefRunning) {
      this.handlers.onLog?.("brief is already running; skipping");
      return;
    }
    this.briefRunning = true;
    try {
      await this.handlers.onBrief();
    } catch (error) {
      this.handlers.onError?.(error);
    } finally {
      this.briefRunning = false;
    }
  }

  async runCheckNow(name: string): Promise<void> {
    const check = this.config.checks.find((item) => item.name === name);
    if (!check) throw new Error(`Unknown check: ${name}`);
    if (this.checksRunning.has(name)) {
      this.handlers.onLog?.(`check ${name} is already running; skipping`);
      return;
    }
    this.checksRunning.add(name);
    try {
      await this.handlers.onCheck(check);
    } catch (error) {
      this.handlers.onError?.(error);
    } finally {
      this.checksRunning.delete(name);
    }
  }

  private scheduleBrief(): void {
    if (this.stopped) return;
    const next = nextDailyRun(this.config.brief.at);
    const delay = Math.max(1000, next.getTime() - Date.now());
    this.handlers.onLog?.(`next brief at ${next.toLocaleString()}`);
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.runBriefNow().finally(() => this.scheduleBrief());
    }, Math.min(delay, MAX_TIMEOUT));
    this.timers.add(timer);
  }

  private scheduleCheck(check: CheckConfig): void {
    if (this.stopped) return;
    const interval = parseDuration(check.every);
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.runCheckNow(check.name).finally(() => {
        if (!this.stopped) this.scheduleCheck(check);
      });
    }, Math.min(interval, MAX_TIMEOUT));
    this.timers.add(timer);
  }
}
