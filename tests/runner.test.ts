import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentConfig } from "../src/agent/config.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "duet-state-"));
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "duet-config-"));
const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "duet-bin-"));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "duet-work-"));

process.env.OPENCODE_DUET_STATE_DIR = stateDir;
process.env.OPENCODE_DUET_CONFIG_DIR = configDir;
process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;

const fakeOpenCode = path.join(binDir, "opencode");
const fakeText =
  'BRIEF OK\n\n```duet-action\n{"type":"shell","title":"Test action","command":"echo approved"}\n```';
fs.writeFileSync(
  fakeOpenCode,
  `#!/usr/bin/env node
const text = ${JSON.stringify(fakeText)};
console.log(JSON.stringify({ type: "text", sessionID: "ses_fake", part: { type: "text", text } }));
console.log(JSON.stringify({ type: "step_finish", sessionID: "ses_fake", part: { reason: "stop", cost: 0 } }));
`,
  { mode: 0o755 },
);

const config: AgentConfig = {
  version: 1,
  name: "Test Duet",
  cwd: workDir,
  session: "ses_fake",
  brief: { enabled: true, at: "08:00", prompt: "napravi brief" },
  checks: [],
  sources: [{ name: "date", command: "echo 2026-10-23" }],
  notify: { macos: false },
  approvals: { enabled: true },
};

let runner: typeof import("../src/agent/runner.js");
let approvals: typeof import("../src/agent/approvals.js");

beforeAll(async () => {
  runner = await import("../src/agent/runner.js");
  approvals = await import("../src/agent/approvals.js");
});

describe("agent runner", () => {
  it("parses action blocks", () => {
    const actions = runner.parseActions(
      [
        "text",
        "```duet-action",
        '{"type":"shell","title":"x","command":"echo x"}',
        "```",
      ].join("\n"),
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      type: "shell",
      title: "x",
      command: "echo x",
    });
  });

  it("builds a prompt with sources and rules", () => {
    const prompt = runner.buildPrompt(config, "task", [
      { name: "date", output: "2026-10-23" },
    ]);
    expect(prompt).toContain("IZVORI");
    expect(prompt).toContain("2026-10-23");
    expect(prompt).toContain("duet-action");
  });

  it("runs the brief, saves it and queues approvals", async () => {
    const result = await runner.runBrief(config);
    expect(result.text).toContain("BRIEF OK");
    expect(result.approvals).toHaveLength(1);
    expect(fs.existsSync(result.briefPath)).toBe(true);
    expect(fs.readFileSync(result.briefPath, "utf8")).toContain("BRIEF OK");

    const store = new approvals.ApprovalStore();
    const pending = store.list("pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      type: "shell",
      title: "Test action",
      command: "echo approved",
    });
  });
});
