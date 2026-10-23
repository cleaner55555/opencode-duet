import { describe, expect, it } from "vitest";
import {
  formatDuration,
  nextDailyRun,
  parseAt,
  parseDuration,
  Scheduler,
} from "../src/agent/scheduler.js";
import type { AgentConfig } from "../src/agent/config.js";

const config: AgentConfig = {
  version: 1,
  name: "Test",
  cwd: "~",
  session: "ses_test",
  brief: { enabled: true, at: "08:00", prompt: "brief" },
  checks: [{ name: "inbox", every: "2h", prompt: "check" }],
  sources: [],
  notify: { macos: false },
  approvals: { enabled: true },
};

describe("scheduler", () => {
  it("parses durations", () => {
    expect(parseDuration("30m")).toBe(1_800_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("1d")).toBe(86_400_000);
    expect(() => parseDuration("2 hours")).toThrow();
  });

  it("formats durations", () => {
    expect(formatDuration(30_000)).toBe("30s");
    expect(formatDuration(1_800_000)).toBe("30m");
    expect(formatDuration(7_200_000)).toBe("2.0h");
    expect(formatDuration(172_800_000)).toBe("2.0d");
  });

  it("parses times", () => {
    expect(parseAt("08:05")).toEqual({ hour: 8, minute: 5 });
    expect(() => parseAt("24:00")).toThrow();
  });

  it("computes the next daily run", () => {
    const now = new Date(2026, 9, 23, 7, 30, 0);
    const next = nextDailyRun("08:00", now);
    expect(next.getDate()).toBe(23);
    expect(next.getHours()).toBe(8);

    const later = new Date(2026, 9, 23, 9, 0, 0);
    const tomorrow = nextDailyRun("08:00", later);
    expect(tomorrow.getDate()).toBe(24);
  });

  it("reports status", () => {
    const scheduler = new Scheduler(config, {
      onBrief: async () => {},
      onCheck: async () => {},
    });
    const status = scheduler.status(new Date(2026, 9, 23, 7, 0, 0));
    expect(status).toContain("brief: 08:00");
    expect(status).toContain("check inbox: every 2h");
  });
});
