import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SharedMemory } from "../src/duet/memory.js";

const dirs: string[] = [];

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duet-memory-"));
  dirs.push(dir);
  return path.join(dir, "memory.json");
}

afterEach(() => {
  while (dirs.length) {
    fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

describe("shared memory", () => {
  it("stores notes and exposes them in the context", () => {
    const memory = new SharedMemory(null);
    memory.appendNote("Deploy is on Friday", "Host");
    expect(memory.read()).toContain("Deploy is on Friday");
    expect(memory.contextFor("sales")).toContain("Deploy is on Friday");
  });

  it("shares turns across channels but not back to their own channel", () => {
    const memory = new SharedMemory(null);
    memory.recordTurn({
      channel: "sales",
      user: "Guest",
      prompt: "close the deal",
      response: "deal closed",
    });

    const main = memory.contextFor("main");
    expect(main).toContain("[#sales]");
    expect(main).toContain("close the deal");
    expect(main).toContain("deal closed");

    const sales = memory.contextFor("sales");
    expect(sales).not.toContain("close the deal");
  });

  it("decorates a prompt with channel metadata and memory", () => {
    const memory = new SharedMemory(null);
    memory.appendNote("Use staging first", "Host");
    const prompt = memory.decorate("support", "check the ticket", 3);
    expect(prompt).toContain("[Duet workspace | channel #support | 3 channels]");
    expect(prompt).toContain("Use staging first");
    expect(prompt).toContain("[End shared memory]");
    expect(prompt.endsWith("check the ticket")).toBe(true);
  });

  it("adds only a channel header when memory is empty", () => {
    const memory = new SharedMemory(null);
    const prompt = memory.decorate("main", "hello", 1);
    expect(prompt).toBe(
      "[Duet workspace | channel #main | 1 channel]\n\nhello",
    );
  });

  it("persists memory across reloads", () => {
    const file = tempFile();
    const memory = new SharedMemory(file);
    memory.appendNote("Persisted note", "Host");
    memory.recordTurn({
      channel: "sales",
      user: "Guest",
      prompt: "p",
      response: "r",
    });

    const reloaded = new SharedMemory(file);
    expect(reloaded.read()).toContain("Persisted note");
    expect(reloaded.contextFor("main")).toContain("[#sales]");
  });

  it("keeps the newest entries when the limit is reached", () => {
    const memory = new SharedMemory(null, 4);
    memory.appendNote("note one", "Host");
    memory.appendNote("note two", "Host");
    memory.recordTurn({
      channel: "a",
      user: "Guest",
      prompt: "old turn",
      response: "old",
    });
    memory.recordTurn({
      channel: "b",
      user: "Guest",
      prompt: "new turn",
      response: "new",
    });
    memory.appendNote("note three", "Host");
    const read = memory.read();
    expect(read).toContain("note three");
    expect(read).toContain("new turn");
    expect(read).not.toContain("old turn");
  });
});
