import readline from "node:readline";
import pc from "picocolors";
import type { ServerMessage } from "./protocol.js";

export interface UiOptions {
  name: string;
  role: "host" | "guest";
  onChat: (text: string) => void;
  onPrompt: (text: string) => void;
  onApprove?: (id: string, approved: boolean) => void;
  onAuto?: (enabled: boolean) => void;
  onExit: () => void;
  status?: () => string;
}

export interface Ui {
  print: (message: ServerMessage) => void;
  close: () => void;
  rl: readline.Interface;
}

const PROMPT_RE = /^@(opencode|oc|duet)\s+([\s\S]+)$/i;

function short(value: unknown, max = 400): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}

export function createUi(options: UiOptions): Ui {
  const label = options.role === "host" ? "host" : "guest";
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: pc.bold(pc.cyan("you> ")),
    historySize: 200,
  });

  const write = (line = "") => {
    process.stdout.write("\r\x1b[2K" + line + "\n");
  };

  const reprompt = () => {
    rl.prompt(true);
  };

  const print = (message: ServerMessage) => {
    process.stdout.write("\r\x1b[2K");
    switch (message.type) {
      case "chat": {
        const color = message.source === "host" ? pc.cyan : pc.magenta;
        write(`${color(message.user)}: ${message.text}`);
        break;
      }
      case "stream":
        write(`${pc.green("opencode>")} ${message.text}`);
        break;
      case "tool": {
        const output = message.output ? ` → ${short(message.output)}` : "";
        write(pc.dim(`[tool] ${message.tool} ${short(message.input, 240)}${output}`));
        break;
      }
      case "turn_complete":
        write(
          pc.dim(
            `— turn complete in ${(message.durationMs / 1000).toFixed(1)}s` +
              (message.cost ? ` ($${message.cost.toFixed(4)})` : ""),
          ),
        );
        break;
      case "notice":
        write(pc.dim(message.message));
        break;
      case "error":
        write(pc.red(`error: ${message.message}`));
        break;
      case "presence":
        write(
          pc.dim(
            `online: ${message.users.map((u) => `${u.name} (${u.role})`).join(", ")}`,
          ),
        );
        break;
      case "approval_request":
        write(
          pc.yellow(
            `approval ${pc.bold(message.promptId)} from ${message.user}: ${message.text}`,
          ),
        );
        write(
          pc.dim(`  host: /approve ${message.promptId.slice(0, 8)} y   or   /approve ${message.promptId.slice(0, 8)} n`),
        );
        break;
      case "typing":
        if (message.isTyping) write(pc.dim(`${message.user} is typing…`));
        break;
      case "join_accepted":
        write(
          pc.green(
            `joined ${message.sessionId} — host ${message.hostUser}, approval ${
              message.approvalMode ? "on" : "off"
            }`,
          ),
        );
        break;
      case "join_rejected":
        write(pc.red(`join rejected: ${message.reason}`));
        break;
      case "prompt_received":
        write(pc.dim(`→ ${message.user}: ${message.text}`));
        break;
    }
    reprompt();
  };

  const help = () => {
    write(
      [
        pc.bold("commands"),
        "  <text>                 chat with the other person",
        "  @opencode <prompt>     send a prompt to OpenCode (alias @oc, @duet)",
        ...(options.role === "host"
          ? [
              "  /approve <id> y|n      approve or deny a guest prompt",
              "  /auto on|off           toggle guest approval mode",
            ]
          : []),
        "  /status                connection status",
        "  /help                  this help",
        "  /exit                  leave",
      ].join("\n"),
    );
  };

  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) {
      reprompt();
      return;
    }

    if (text.startsWith("/")) {
      const [command, ...rest] = text.slice(1).split(/\s+/);
      const arg = rest.join(" ");
      switch (command.toLowerCase()) {
        case "help":
          help();
          break;
        case "exit":
        case "quit":
          options.onExit();
          return;
        case "status":
          write(
            options.status?.() ??
              pc.dim(`${options.name} (${label}) — connected`),
          );
          break;
        case "approve": {
          if (options.role !== "host") {
            write(pc.red("only the host can approve prompts"));
            break;
          }
          const [id, verdict] = arg.split(/\s+/);
          if (!id) {
            write(pc.red("usage: /approve <id> y|n"));
            break;
          }
          const approved = !verdict || /^y(es)?$/i.test(verdict);
          options.onApprove?.(id, approved);
          break;
        }
        case "auto": {
          if (options.role !== "host") {
            write(pc.red("only the host can toggle auto"));
            break;
          }
          const enabled = /^(on|true|1|yes)$/i.test(arg);
          options.onAuto?.(enabled);
          break;
        }
        default:
          write(pc.red(`unknown command: /${command}`));
          break;
      }
      reprompt();
      return;
    }

    const match = text.match(PROMPT_RE);
    if (match) {
      options.onPrompt(match[2].trim());
    } else {
      options.onChat(text);
    }
    reprompt();
  });

  rl.on("SIGINT", () => {
    options.onExit();
  });

  write(
    pc.dim(
      `opencode-duet — ${options.name} (${label}). Type /help for commands.`,
    ),
  );
  reprompt();

  return {
    print,
    close: () => rl.close(),
    rl,
  };
}
