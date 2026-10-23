import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovalStore } from "../src/agent/approvals.js";

function store(): ApprovalStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duet-approvals-"));
  return new ApprovalStore(path.join(dir, "approvals.json"));
}

describe("approvals", () => {
  it("adds and lists pending approvals", () => {
    const s = store();
    const approval = s.add({
      type: "shell",
      title: "say hi",
      command: "echo hi",
    });
    expect(approval.id).toMatch(/^ap-[0-9a-f]{8}$/);
    expect(s.list("pending")).toHaveLength(1);
    expect(s.get(approval.id.slice(0, 5))?.id).toBe(approval.id);
  });

  it("executes an approved shell action", async () => {
    const s = store();
    const approval = s.add({
      type: "shell",
      title: "say hi",
      command: "echo hi",
    });
    const result = await s.approve(approval.id);
    expect(result.status).toBe("done");
    expect(result.result).toBe("hi");
  });

  it("rejects an action without executing it", () => {
    const s = store();
    const approval = s.add({
      type: "shell",
      title: "danger",
      command: "rm -rf /tmp/never",
    });
    const result = s.reject(approval.id);
    expect(result.status).toBe("rejected");
    expect(s.list("pending")).toHaveLength(0);
  });

  it("marks a failing action as failed", async () => {
    const s = store();
    const approval = s.add({
      type: "shell",
      title: "fail",
      command: "exit 7",
    });
    const result = await s.approve(approval.id);
    expect(result.status).toBe("failed");
  });
});
