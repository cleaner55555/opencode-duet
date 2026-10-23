import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChannelStore, slugifyChannel } from "../src/duet/channels.js";

const dirs: string[] = [];

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duet-channels-"));
  dirs.push(dir);
  return path.join(dir, "channels.json");
}

afterEach(() => {
  while (dirs.length) {
    fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

describe("channel store", () => {
  it("starts with a main channel bound to the base session", () => {
    const store = new ChannelStore(null, "ses_base");
    expect(store.main).toMatchObject({
      id: "main",
      name: "main",
      sessionId: "ses_base",
      archived: false,
    });
    expect(store.list()).toHaveLength(1);
  });

  it("creates slugged channels with their own session ids", () => {
    const store = new ChannelStore(null, "ses_base");
    const channel = store.create("Sales Q4", "Host");
    expect(channel).toMatchObject({
      id: "sales-q4",
      name: "Sales Q4",
      createdBy: "Host",
      archived: false,
    });
    expect(channel.sessionId).toMatch(/^ses_duet_salesq4_[a-f0-9]{8}$/);
    expect(store.get("#Sales Q4")).toBe(channel);
    expect(store.get("sales-q4")).toBe(channel);
  });

  it("stores a provided OpenCode child session id", () => {
    const store = new ChannelStore(null, "ses_base");
    const channel = store.create(
      "sales",
      "Host",
      undefined,
      "ses_child_123",
    );
    expect(channel.sessionId).toBe("ses_child_123");
    expect(store.assertAvailable("marketing")).toBe("marketing");
    expect(() => store.assertAvailable("sales")).toThrow("already exists");
    expect(() =>
      store.create("support", "Host", undefined, "not-a-session"),
    ).toThrow("invalid OpenCode session id");
  });

  it("persists channels and reloads them", () => {
    const file = tempFile();
    const store = new ChannelStore(file, "ses_base");
    store.create("support", "Host");
    const reloaded = new ChannelStore(file, "ses_base");
    expect(reloaded.list().map((channel) => channel.name)).toEqual([
      "main",
      "support",
    ]);
    expect(reloaded.get("support")?.sessionId).toMatch(/^ses_duet_support_/);
  });

  it("rejects duplicate names and keeps ids unique", () => {
    const store = new ChannelStore(null, "ses_base");
    store.create("Sales Q4", "Host");
    expect(() => store.create("sales q4", "Host")).toThrow(
      "already exists",
    );
    const second = store.create("sales-q4", "Host");
    expect(second.id).toBe("sales-q4-2");
  });

  it("archives channels but never main", () => {
    const store = new ChannelStore(null, "ses_base");
    const channel = store.create("temp", "Host");
    expect(() => store.archive("main")).toThrow("cannot be archived");
    expect(store.archive("temp")).toMatchObject({ archived: true });
    expect(store.list().map((item) => item.name)).not.toContain("temp");
    expect(store.list(true).map((item) => item.name)).toContain("temp");
    expect(store.get(channel.id)?.archived).toBe(true);
  });

  it("slugifies display names safely", () => {
    expect(slugifyChannel("  Sales Q4!  ")).toBe("sales-q4");
    expect(slugifyChannel("Šđčćž")).toBe("s-ccz");
    expect(slugifyChannel("!!!")).toBe("channel");
  });
});
