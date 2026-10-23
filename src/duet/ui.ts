import readline from "node:readline";
import { oc as pc } from "../theme.js";
import type {
  ChannelInfo,
  HistoryEntry,
  ServerMessage,
} from "./protocol.js";

export interface UiOptions {
  name: string;
  role: "host" | "guest";
  onChat: (text: string) => void;
  onPrompt: (text: string) => void;
  onApprove?: (id: string, approved: boolean) => void;
  onAuto?: (enabled: boolean) => void;
  onSwitchChannel?: (channel: string) => void;
  onCreateChannel?: (name: string) => void;
  onArchiveChannel?: (name: string) => void;
  onChannels?: () => void;
  onMemory?: () => void;
  onMemoryAdd?: (text: string) => void;
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
  let activeChannel = "main";
  let channels: ChannelInfo[] = [];
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "",
    historySize: 200,
  });

  const promptFor = () => pc.bold(pc.primary(`you [#${activeChannel}]> `));
  const setPrompt = () => rl.setPrompt(promptFor());

  const write = (line = "") => {
    process.stdout.write("\r\x1b[2K" + line + "\n");
  };

  const reprompt = () => {
    rl.prompt(true);
  };

  const otherChannel = (message: { channelId?: string }) =>
    Boolean(message.channelId && message.channelId !== activeChannel);

  const prefix = (message: { channelId?: string; channelName?: string }) =>
    otherChannel(message) && message.channelName
      ? pc.dim(`[#${message.channelName}] `)
      : "";

  const printHistory = (entries: HistoryEntry[]) => {
    for (const entry of entries) {
      if (entry.kind === "assistant") {
        write(`${pc.green("opencode>")} ${entry.text}`);
      } else if (entry.kind === "prompt") {
        write(pc.dim(`→ ${entry.user}: ${entry.text}`));
      } else {
        const color = entry.source === "host" ? pc.info : pc.accent;
        write(`${color(entry.user)}: ${entry.text}`);
      }
    }
  };

  const print = (message: ServerMessage) => {
    process.stdout.write("\r\x1b[2K");
    switch (message.type) {
      case "channels": {
        channels = message.channels;
        activeChannel = message.active;
        setPrompt();
        const list = message.channels
          .map((channel) => {
            const name =
              channel.id === activeChannel
                ? pc.bold(pc.primary(`#${channel.name}`))
                : pc.dim(`#${channel.name}`);
            const count =
              channel.messageCount === undefined
                ? ""
                : pc.dim(` (${channel.messageCount})`);
            return name + count;
          })
          .join("  ");
        write(pc.dim(`channels: ${list}`));
        break;
      }
      case "channel_switched":
        activeChannel = message.channel.id;
        setPrompt();
        write(
          pc.primary(
            `switched to #${message.channel.name} — session ${message.channel.sessionId}`,
          ),
        );
        break;
      case "channel_history":
        if (message.entries.length === 0) {
          write(pc.dim(`#${message.channel.name}: no history yet`));
        } else {
          write(pc.dim(`— #${message.channel.name} history —`));
          printHistory(message.entries);
        }
        break;
      case "memory":
        write(pc.bold("shared memory"));
        for (const line of message.text.split("\n")) write(pc.dim(line));
        break;
      case "chat": {
        const color = message.source === "host" ? pc.info : pc.accent;
        if (otherChannel(message)) {
          write(pc.dim(`${prefix(message)}${message.user}: ${message.text}`));
        } else {
          write(`${color(message.user)}: ${message.text}`);
        }
        break;
      }
      case "stream":
        if (!otherChannel(message)) {
          write(`${pc.green("opencode>")} ${message.text}`);
        }
        break;
      case "tool": {
        if (otherChannel(message)) break;
        const output = message.output ? ` → ${short(message.output)}` : "";
        write(pc.dim(`[tool] ${message.tool} ${short(message.input, 240)}${output}`));
        break;
      }
      case "turn_complete":
        if (otherChannel(message)) {
          write(pc.dim(`${prefix(message)}turn complete`));
        } else {
          write(
            pc.dim(
              `— turn complete in ${(message.durationMs / 1000).toFixed(1)}s` +
                (message.cost ? ` ($${message.cost.toFixed(4)})` : ""),
            ),
          );
        }
        break;
      case "notice":
        write(pc.dim(message.message));
        break;
      case "error":
        write(pc.red(`${prefix(message)}error: ${message.message}`));
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
            `${prefix(message)}approval ${pc.bold(message.promptId)} from ${message.user}: ${message.text}`,
          ),
        );
        write(
          pc.dim(
            `  host: /approve ${message.promptId.slice(0, 8)} y   or   /approve ${message.promptId.slice(0, 8)} n`,
          ),
        );
        break;
      case "typing":
        if (message.isTyping) write(pc.dim(`${message.user} is typing…`));
        break;
      case "join_accepted":
        activeChannel = message.activeChannel;
        channels = message.channels;
        setPrompt();
        write(
          pc.green(
            `joined ${message.sessionId} — host ${message.hostUser}, approval ${
              message.approvalMode ? "on" : "off"
            }, channel #${activeChannel}`,
          ),
        );
        break;
      case "join_rejected":
        write(pc.red(`join rejected: ${message.reason}`));
        break;
      case "prompt_received":
        write(
          pc.dim(`${prefix(message)}→ ${message.user}: ${message.text}`),
        );
        break;
    }
    reprompt();
  };

  const listChannels = () => {
    if (channels.length === 0) {
      write(pc.dim("no channels"));
      return;
    }
    for (const channel of channels) {
      const marker = channel.id === activeChannel ? pc.primary("*") : " ";
      const count =
        channel.messageCount === undefined ? "" : ` · ${channel.messageCount} msgs`;
      write(
        `${marker} #${channel.name}${count} ${pc.dim(channel.sessionId)}`,
      );
    }
  };

  const help = () => {
    write(
      [
        pc.bold("commands"),
        "  <text>                 chat with the other person",
        "  @opencode <prompt>     send a prompt to the active channel",
        "  /channels              list channels (virtual sessions)",
        "  /new <name>            create a channel",
        "  /switch <name>         switch channel",
        ...(options.role === "host"
          ? [
              "  /close <name>          archive a channel",
              "  /approve <id> y|n      approve or deny a guest prompt",
              "  /auto on|off           toggle guest approval mode",
            ]
          : []),
        "  /memory                show shared memory",
        "  /memory add <text>     add a note to shared memory",
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
      const arg = rest.join(" ").trim();
      switch (command.toLowerCase()) {
        case "help":
          help();
          break;
        case "exit":
        case "quit":
          options.onExit();
          return;
        case "channels":
          if (options.onChannels) options.onChannels();
          else listChannels();
          break;
        case "new":
          if (!arg) {
            write(pc.red("usage: /new <name>"));
            break;
          }
          options.onCreateChannel?.(arg);
          break;
        case "switch":
        case "s":
          if (!arg) {
            write(pc.red("usage: /switch <name>"));
            break;
          }
          options.onSwitchChannel?.(arg);
          break;
        case "close":
        case "archive":
          if (options.role !== "host") {
            write(pc.red("only the host can archive channels"));
            break;
          }
          if (!arg) {
            write(pc.red("usage: /close <name>"));
            break;
          }
          options.onArchiveChannel?.(arg);
          break;
        case "memory": {
          if (!arg) {
            options.onMemory?.();
            break;
          }
          const note = arg.replace(/^add\s+/i, "").trim();
          if (!/^add(\s|$)/i.test(arg) || !note) {
            write(pc.red("usage: /memory  or  /memory add <text>"));
            break;
          }
          options.onMemoryAdd?.(note);
          break;
        }
        case "status":
          write(
            (options.status?.() ??
              pc.dim(`${options.name} (${label}) — connected`)) +
              pc.dim(` — #${activeChannel}`),
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

  setPrompt();
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
