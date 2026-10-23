import { randomBytes } from "node:crypto";
import readline from "node:readline";
import pc from "picocolors";
import { OpenCodeBridge, type BridgeEvent } from "./opencode.js";
import { loadAgentConfig } from "./agent/config.js";
import { CONFIG_FILE, expandHome } from "./paths.js";

export interface ChatOptions {
  session?: string;
  model?: string;
  cwd?: string;
  config?: string;
  agent?: string;
  auto?: boolean;
}

export async function chatCommand(options: ChatOptions = {}): Promise<void> {
  const config = loadAgentConfig(options.config ?? CONFIG_FILE);
  let sessionId =
    options.session?.trim() ||
    config.session ||
    `ses_duet_chat_${randomBytes(4).toString("hex")}`;
  const cwd = expandHome(options.cwd ?? config.cwd ?? process.cwd());
  const model = options.model ?? config.model;
  const agent = options.agent ?? config.agent;

  const bridge = new OpenCodeBridge();
  let rl: readline.Interface | null = null;
  const reprompt = () => rl?.prompt(true);

  bridge.on("event", (event: BridgeEvent) => {
    process.stdout.write("\r\x1b[2K");
    switch (event.type) {
      case "text":
        process.stdout.write(`${pc.green("opencode>")} ${event.text}\n`);
        break;
      case "tool":
        process.stdout.write(pc.dim(`[tool] ${event.tool}\n`));
        break;
      case "error":
        process.stdout.write(pc.red(`error: ${event.message}\n`));
        break;
      case "done":
        process.stdout.write(pc.dim("— done\n"));
        break;
      case "log":
        if (process.env.OPENCODE_DUET_DEBUG) {
          process.stdout.write(pc.dim(event.message + "\n"));
        }
        break;
      case "step":
        break;
    }
    reprompt();
  });

  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: pc.bold(pc.cyan("you> ")),
    historySize: 200,
  });

  console.log(
    pc.dim(
      `OpenCode Duet chat — session ${sessionId}\n` +
        `cwd ${cwd}${model ? ` — model ${model}` : ""}\n` +
        "Type /new for a fresh session, /exit to leave.",
    ),
  );
  rl.prompt();

  const exit = () => {
    bridge.cancel();
    rl?.close();
    process.exit(0);
  };

  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) {
      rl?.prompt();
      return;
    }
    if (text === "/exit" || text === "/quit") {
      exit();
      return;
    }
    if (text === "/new") {
      sessionId = `ses_duet_${randomBytes(6).toString("hex")}`;
      console.log(pc.dim(`new session: ${sessionId}`));
      rl?.prompt();
      return;
    }
    if (bridge.isBusy()) {
      console.log(pc.yellow("opencode is busy; wait for the current turn"));
      rl?.prompt();
      return;
    }

    void bridge
      .run({
        prompt: text,
        sessionId,
        cwd,
        model,
        agent,
        auto: Boolean(options.auto),
        timeoutMs: 20 * 60 * 1000,
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.log(pc.red(`error: ${message}`));
        rl?.prompt();
      });
    rl?.prompt();
  });

  rl.on("SIGINT", exit);
  process.on("SIGTERM", exit);
}
