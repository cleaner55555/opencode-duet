import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import os from "node:os";
import localtunnel from "localtunnel";
import pc from "picocolors";
import { OpenCodeBridge } from "../opencode.js";
import { workspaceFile } from "../paths.js";
import { DuetServer } from "./server.js";
import { createUi } from "./ui.js";
import { ChannelStore } from "./channels.js";
import { SharedMemory } from "./memory.js";
import type { ServerMessage } from "./protocol.js";

export interface HostOptions {
  name?: string;
  port?: string;
  password?: string;
  session?: string;
  model?: string;
  agent?: string;
  cwd?: string;
  auto?: boolean;
  tunnel?: string;
}

function lanAddress(): string {
  const interfaces = os.networkInterfaces();
  const preferred = ["en0", "en1", "eth0", "wlan0"];
  const names = [
    ...preferred.filter((name) => interfaces[name]),
    ...Object.keys(interfaces).filter((name) => !preferred.includes(name)),
  ];
  for (const name of names) {
    for (const address of interfaces[name] ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        return address.address;
      }
    }
  }
  return "127.0.0.1";
}

async function startLocaltunnel(
  port: number,
): Promise<{ url: string; close: () => void }> {
  const tunnel = await localtunnel({ port });
  return {
    url: tunnel.url,
    close: () => tunnel.close(),
  };
}

async function startNgrok(port: number): Promise<{ url: string; child: ChildProcess }> {
  const child = spawn("ngrok", ["http", String(port), "--log=stdout"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const url = await new Promise<string>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("ngrok did not report a public URL within 20s"));
    }, 20_000);

    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
    };

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = buffer.match(/https:\/\/[a-z0-9-]+\.ngrok(?:-free)?\.(?:app|dev)/i);
      if (match) {
        cleanup();
        resolve(match[0]);
      }
    };

    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`ngrok exited with code ${code}`));
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", onExit);
  });

  return { url, child };
}

export async function hostCommand(options: HostOptions): Promise<void> {
  const name = options.name?.trim() || os.userInfo().username;
  const password = options.password?.trim() || randomBytes(4).toString("hex");
  const sessionId =
    options.session?.trim() ||
    `ses_duet_${randomBytes(6).toString("hex")}`;
  const requestedPort = options.port ? Number(options.port) : 0;
  if (!Number.isFinite(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    throw new Error(`Invalid port: ${options.port}`);
  }

  const tunnelProvider = (options.tunnel ?? "none").toLowerCase();
  if (!["none", "ngrok", "localtunnel"].includes(tunnelProvider)) {
    throw new Error(`Unknown tunnel "${options.tunnel}" (use none, ngrok, localtunnel)`);
  }

  const bridge = new OpenCodeBridge();
  const channels = new ChannelStore(
    workspaceFile(sessionId, "channels.json"),
    sessionId,
  );
  const memory = new SharedMemory(workspaceFile(sessionId, "memory.json"));
  const server = new DuetServer({
    hostUser: name,
    password,
    sessionId,
    bridge,
    approvalMode: !options.auto,
    cwd: options.cwd,
    model: options.model,
    agent: options.agent,
    auto: Boolean(options.auto),
    channels,
    memory,
  });

  const port = await server.start(requestedPort);
  const lanUrl = `ws://${lanAddress()}:${port}`;

  let tunnelUrl: string | null = null;
  let ngrok: ChildProcess | null = null;
  let closeTunnel: (() => void) | null = null;

  if (tunnelProvider === "ngrok") {
    try {
      const tunnel = await startNgrok(port);
      tunnelUrl = tunnel.url;
      ngrok = tunnel.child;
      closeTunnel = () => tunnel.child.kill();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(pc.yellow(`ngrok failed: ${message}`));
      console.error(pc.dim("Continuing with LAN URL only."));
    }
  } else if (tunnelProvider === "localtunnel") {
    try {
      const tunnel = await startLocaltunnel(port);
      tunnelUrl = tunnel.url;
      closeTunnel = tunnel.close;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(pc.yellow(`localtunnel failed: ${message}`));
      console.error(pc.dim("Continuing with LAN URL only."));
    }
  }

  const joinUrl = tunnelUrl ?? lanUrl;
  const joinCommand = `opencode-duet join ${joinUrl} --password ${password} --name guest`;

  console.log("");
  console.log(pc.bold(pc.green("OpenCode Duet — session ready")));
  console.log(`  host:     ${pc.cyan(name)}`);
  console.log(`  session:  ${sessionId}`);
  console.log(`  channels: #main (use /new <name> to add one)`);
  console.log(`  approval: ${options.auto ? "off (--auto)" : "on"}`);
  console.log(`  local:    ${lanUrl}`);
  if (tunnelUrl) console.log(`  public:   ${tunnelUrl}`);
  console.log("");
  console.log(pc.bold("Send this to your partner:"));
  console.log(pc.cyan(`  ${joinCommand}`));
  console.log("");

  let closed = false;
  const shutdown = async (code = 0) => {
    if (closed) return;
    closed = true;
    ui?.close();
    await server.stop();
    if (ngrok) ngrok.kill();
    closeTunnel?.();
    process.exit(code);
  };

  const ui = createUi({
    name,
    role: "host",
    onChat: (text) => server.hostChat(text),
    onPrompt: (text) => server.hostPrompt(text),
    onApprove: (id, approved) => server.approve(id, approved),
    onAuto: (enabled) => server.setApprovalMode(enabled),
    onSwitchChannel: (channel) => server.switchChannel("host", channel),
    onCreateChannel: (channelName) =>
      server.createChannel("host", channelName),
    onArchiveChannel: (channel) => server.archiveChannel("host", channel),
    onChannels: () => server.sendChannels("host"),
    onMemory: () => server.sendMemory("host"),
    onMemoryAdd: (text) => server.addMemory("host", text),
    onExit: () => void shutdown(0),
    status: () =>
      pc.dim(
        `host ${name} — ${server.users().length} online — approval ${
          server.isApprovalMode ? "on" : "off"
        } — ${joinUrl}`,
      ),
  });

  server.on("message", (message: ServerMessage) => ui.print(message));
  server.on("approval_request", (pending) => {
    ui.print({
      type: "approval_request",
      promptId: pending.id,
      user: pending.user,
      text: pending.text,
      timestamp: pending.createdAt,
    });
  });
  server.on("log", (line: string) => {
    if (process.env.OPENCODE_DUET_DEBUG) ui.print({
      type: "notice",
      message: line,
      timestamp: Date.now(),
    });
  });
  server.sendChannels("host");

  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
}
