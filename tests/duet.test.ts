import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentBridge, RunPromptOptions } from "../src/opencode.js";
import { DuetClient } from "../src/duet/client.js";
import { DuetServer, type PendingPrompt } from "../src/duet/server.js";
import type { SessionCreator } from "../src/duet/sessions.js";
import type { ServerMessage } from "../src/duet/protocol.js";

class FakeBridge extends EventEmitter implements AgentBridge {
  runs: RunPromptOptions[] = [];

  run(options: RunPromptOptions): Promise<void> {
    this.runs.push(options);
    this.emit("event", { type: "text", text: `echo: ${options.prompt}` });
    this.emit("event", {
      type: "done",
      exitCode: 0,
      sessionId: options.sessionId,
    });
    return Promise.resolve();
  }

  cancel(): void {}

  isBusy(): boolean {
    return false;
  }

  lastSessionId(): string | null {
    return this.runs.at(-1)?.sessionId ?? null;
  }
}

class FakeSessions implements SessionCreator {
  children: Array<{ parentId: string; title: string }> = [];
  removed: string[] = [];
  fail = false;

  async ensureBase(): Promise<void> {}

  async createChild(parentId: string, title: string): Promise<string> {
    if (this.fail) throw new Error("opencode api unavailable");
    this.children.push({ parentId, title });
    return `ses_child_${this.children.length}`;
  }

  async remove(sessionId: string): Promise<void> {
    this.removed.push(sessionId);
  }
}

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

function waitFor<T extends ServerMessage["type"]>(
  client: DuetClient,
  type: T,
  timeoutMs = 3000,
): Promise<Extract<ServerMessage, { type: T }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for ${type}`)),
      timeoutMs,
    );
    const handler = (message: ServerMessage) => {
      if (message.type !== type) return;
      clearTimeout(timer);
      client.off("message", handler);
      resolve(message as Extract<ServerMessage, { type: T }>);
    };
    client.on("message", handler);
  });
}

async function startDuet(
  approvalMode = true,
  sessions?: SessionCreator,
) {
  const bridge = new FakeBridge();
  const server = new DuetServer({
    hostUser: "Host",
    password: "secret",
    sessionId: "ses_test",
    bridge,
    approvalMode,
    sessions,
  });
  const port = await server.start(0);
  cleanups.push(() => server.stop());
  return { server, port, bridge };
}

describe("duet server/client", () => {
  it("joins, chats and streams a host prompt", async () => {
    const { server, port } = await startDuet();
    const client = new DuetClient("Guest", "secret");
    cleanups.push(() => client.close());

    const joined = await client.connect(`ws://127.0.0.1:${port}`);
    expect(joined.sessionId).toBe("ses_test");
    expect(joined.hostUser).toBe("Host");
    expect(joined.activeChannel).toBe("main");
    expect(joined.channels[0]).toMatchObject({
      id: "main",
      name: "main",
      sessionId: "ses_test",
    });

    const chat = waitFor(client, "chat");
    client.sendChat("hello host");
    await expect(chat).resolves.toMatchObject({
      user: "Guest",
      text: "hello host",
      source: "guest",
      channelId: "main",
    });

    const stream = waitFor(client, "stream");
    const done = waitFor(client, "turn_complete");
    server.hostPrompt("write tests");
    const output = await stream;
    expect(output.text).toContain("echo:");
    expect(output.text).toContain("write tests");
    expect(output.channelId).toBe("main");
    await expect(done).resolves.toMatchObject({ channelId: "main" });
  });

  it("asks the host before running a guest prompt", async () => {
    const { server, port } = await startDuet(true);
    const client = new DuetClient("Guest", "secret");
    cleanups.push(() => client.close());
    await client.connect(`ws://127.0.0.1:${port}`);

    const approval = new Promise<PendingPrompt>((resolve) =>
      server.once("approval_request", resolve),
    );
    client.sendPrompt("fix the bug");
    const pending = await approval;
    expect(pending.text).toBe("fix the bug");
    expect(pending.channelId).toBe("main");

    const stream = waitFor(client, "stream");
    server.approve(pending.id, true);
    const output = await stream;
    expect(output.text).toContain("echo:");
    expect(output.text).toContain("fix the bug");
  });

  it("runs guest prompts immediately in auto mode", async () => {
    const { server, port } = await startDuet(false);
    const client = new DuetClient("Guest", "secret");
    cleanups.push(() => client.close());
    await client.connect(`ws://127.0.0.1:${port}`);

    const stream = waitFor(client, "stream");
    client.sendPrompt("ship it");
    const output = await stream;
    expect(output.text).toContain("echo:");
    expect(output.text).toContain("ship it");
    expect(server.isApprovalMode).toBe(false);
  });

  it("creates a channel and runs prompts in its own OpenCode session", async () => {
    const { port, bridge } = await startDuet(false);
    const client = new DuetClient("Guest", "secret");
    cleanups.push(() => client.close());
    await client.connect(`ws://127.0.0.1:${port}`);

    const switched = waitFor(client, "channel_switched");
    const channels = waitFor(client, "channels");
    client.sendCreateChannel("sales");
    const channel = await switched;
    expect(channel.channel.name).toBe("sales");
    expect(channel.channel.sessionId).toMatch(/^ses_duet_sales_/);
    const list = await channels;
    expect(list.active).toBe(channel.channel.id);
    expect(list.channels.map((item) => item.name)).toContain("sales");

    const stream = waitFor(client, "stream");
    client.sendPrompt("close the deal");
    const output = await stream;
    expect(output.channelId).toBe(channel.channel.id);

    const run = bridge.runs.at(-1)!;
    expect(run.sessionId).toBe(channel.channel.sessionId);
    expect(run.sessionId).not.toBe("ses_test");
    expect(run.prompt).toContain("[Duet workspace | channel #sales");
    expect(run.prompt).toContain("close the deal");
  });

  it("creates channels as OpenCode child sessions under the base session", async () => {
    const sessions = new FakeSessions();
    const { port, bridge } = await startDuet(false, sessions);
    const client = new DuetClient("Guest", "secret");
    cleanups.push(() => client.close());
    await client.connect(`ws://127.0.0.1:${port}`);

    const switched = waitFor(client, "channel_switched");
    const channels = waitFor(client, "channels");
    client.sendCreateChannel("sales");
    const channel = await switched;

    expect(sessions.children).toEqual([
      { parentId: "ses_test", title: "#sales" },
    ]);
    expect(channel.channel.sessionId).toBe("ses_child_1");
    const list = await channels;
    expect(
      list.channels.find((item) => item.id === channel.channel.id)?.sessionId,
    ).toBe("ses_child_1");

    const stream = waitFor(client, "stream");
    client.sendPrompt("close the deal");
    await stream;
    expect(bridge.runs.at(-1)?.sessionId).toBe("ses_child_1");
  });

  it("falls back to a standalone session when child creation fails", async () => {
    const sessions = new FakeSessions();
    sessions.fail = true;
    const { port } = await startDuet(false, sessions);
    const client = new DuetClient("Guest", "secret");
    cleanups.push(() => client.close());
    await client.connect(`ws://127.0.0.1:${port}`);

    const notice = waitFor(client, "notice");
    const switched = waitFor(client, "channel_switched");
    client.sendCreateChannel("sales");
    await expect(notice).resolves.toMatchObject({
      message: expect.stringContaining("standalone session"),
    });
    const channel = await switched;
    expect(channel.channel.sessionId).toMatch(/^ses_duet_sales_/);
  });

  it("keeps channel history separate and replays it on switch", async () => {
    const { port } = await startDuet(false);
    const client = new DuetClient("Guest", "secret");
    cleanups.push(() => client.close());
    await client.connect(`ws://127.0.0.1:${port}`);

    const switched = waitFor(client, "channel_switched");
    client.sendCreateChannel("sales");
    const sales = await switched;
    const chat = waitFor(client, "chat");
    client.sendChat("deal closed");
    await expect(chat).resolves.toMatchObject({
      text: "deal closed",
      channelId: sales.channel.id,
    });

    const mainSwitch = waitFor(client, "channel_switched");
    const mainHistory = waitFor(client, "channel_history");
    client.sendSwitchChannel("main");
    await expect(mainSwitch).resolves.toMatchObject({ active: "main" });
    const main = await mainHistory;
    expect(main.entries.some((entry) => entry.text === "deal closed")).toBe(false);

    const salesSwitch = waitFor(client, "channel_switched");
    const salesHistory = waitFor(client, "channel_history");
    client.sendSwitchChannel("sales");
    await expect(salesSwitch).resolves.toMatchObject({
      active: sales.channel.id,
    });
    const history = await salesHistory;
    expect(history.entries.some((entry) => entry.text === "deal closed")).toBe(
      true,
    );
  });

  it("runs an approved guest prompt in the channel it was sent from", async () => {
    const { server, port, bridge } = await startDuet(true);
    const client = new DuetClient("Guest", "secret");
    cleanups.push(() => client.close());
    await client.connect(`ws://127.0.0.1:${port}`);

    const switched = waitFor(client, "channel_switched");
    client.sendCreateChannel("support");
    const channel = await switched;

    const approval = new Promise<PendingPrompt>((resolve) =>
      server.once("approval_request", resolve),
    );
    client.sendPrompt("answer the ticket");
    const pending = await approval;
    expect(pending.channelId).toBe(channel.channel.id);

    const stream = waitFor(client, "stream");
    server.approve(pending.id, true);
    await stream;
    expect(bridge.runs.at(-1)?.sessionId).toBe(channel.channel.sessionId);
  });

  it("lets the host archive a channel and moves the guest to main", async () => {
    const { server, port } = await startDuet(false);
    const client = new DuetClient("Guest", "secret");
    cleanups.push(() => client.close());
    await client.connect(`ws://127.0.0.1:${port}`);

    const switched = waitFor(client, "channel_switched");
    client.sendCreateChannel("temp");
    const temp = await switched;

    const back = waitFor(client, "channel_switched");
    const channels = waitFor(client, "channels");
    server.archiveChannel("host", temp.channel.id);
    await expect(back).resolves.toMatchObject({ active: "main" });
    const list = await channels;
    expect(list.channels.map((item) => item.name)).not.toContain("temp");

    const error = waitFor(client, "error");
    client.sendArchiveChannel("main");
    await expect(error).resolves.toMatchObject({
      message: expect.stringContaining("only the host"),
    });
  });

  it("injects shared memory into prompts in every channel", async () => {
    const { server, port, bridge } = await startDuet(false);
    const client = new DuetClient("Guest", "secret");
    cleanups.push(() => client.close());
    await client.connect(`ws://127.0.0.1:${port}`);

    server.addMemory("host", "Deploy is on Friday");
    const stream = waitFor(client, "stream");
    client.sendPrompt("when is the deploy?");
    await stream;
    expect(bridge.runs.at(-1)?.prompt).toContain("Deploy is on Friday");
  });

  it("rejects a wrong password", async () => {
    const { port } = await startDuet();
    const client = new DuetClient("Mallory", "wrong");
    cleanups.push(() => client.close());
    await expect(client.connect(`ws://127.0.0.1:${port}`)).rejects.toThrow(
      "Invalid password",
    );
  });
});
