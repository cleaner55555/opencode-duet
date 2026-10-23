import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentBridge, RunPromptOptions } from "../src/opencode.js";
import { DuetClient } from "../src/duet/client.js";
import { DuetServer, type PendingPrompt } from "../src/duet/server.js";
import type { ServerMessage } from "../src/duet/protocol.js";

class FakeBridge extends EventEmitter implements AgentBridge {
  run(options: RunPromptOptions): Promise<void> {
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
    return null;
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

async function startDuet(approvalMode = true) {
  const bridge = new FakeBridge();
  const server = new DuetServer({
    hostUser: "Host",
    password: "secret",
    sessionId: "ses_test",
    bridge,
    approvalMode,
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

    const chat = waitFor(client, "chat");
    client.sendChat("hello host");
    await expect(chat).resolves.toMatchObject({
      user: "Guest",
      text: "hello host",
      source: "guest",
    });

    const stream = waitFor(client, "stream");
    const done = waitFor(client, "turn_complete");
    server.hostPrompt("write tests");
    await expect(stream).resolves.toMatchObject({ text: "echo: write tests" });
    await expect(done).resolves.toBeTruthy();
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

    const stream = waitFor(client, "stream");
    server.approve(pending.id, true);
    await expect(stream).resolves.toMatchObject({ text: "echo: fix the bug" });
  });

  it("runs guest prompts immediately in auto mode", async () => {
    const { server, port } = await startDuet(false);
    const client = new DuetClient("Guest", "secret");
    cleanups.push(() => client.close());
    await client.connect(`ws://127.0.0.1:${port}`);

    const stream = waitFor(client, "stream");
    client.sendPrompt("ship it");
    await expect(stream).resolves.toMatchObject({ text: "echo: ship it" });
    expect(server.isApprovalMode).toBe(false);
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
