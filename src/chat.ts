import { randomBytes } from "node:crypto";
import readline from "node:readline";
import { oc as pc } from "./theme.js";
import { OpenCodeBridge, type BridgeEvent } from "./opencode.js";
import { loadAgentConfig } from "./agent/config.js";
import { CONFIG_FILE, expandHome, workspaceFile } from "./paths.js";
import { ChannelStore, type Channel } from "./duet/channels.js";
import { SharedMemory } from "./duet/memory.js";
import {
  LocalSessionCreator,
  OpenCodeSessionCreator,
  type SessionCreator,
} from "./duet/sessions.js";

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
  const baseSessionId =
    options.session?.trim() ||
    config.session ||
    `ses_duet_chat_${randomBytes(4).toString("hex")}`;
  const cwd = expandHome(options.cwd ?? config.cwd ?? process.cwd());
  const model = options.model ?? config.model;
  const agent = options.agent ?? config.agent;

  const store = new ChannelStore(
    workspaceFile(baseSessionId, "channels.json"),
    baseSessionId,
  );
  const memory = new SharedMemory(workspaceFile(baseSessionId, "memory.json"));
  let active: Channel = store.main;

  const openCodeSessions = new OpenCodeSessionCreator();
  let sessions: SessionCreator = openCodeSessions;
  let childSessions = false;
  try {
    await openCodeSessions.ensureBase(baseSessionId, cwd, "Duet chat");
    childSessions = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(pc.yellow(`OpenCode child sessions unavailable: ${message}`));
    console.log(pc.dim("Channels will use standalone sessions."));
    sessions = new LocalSessionCreator();
  }

  const bridge = new OpenCodeBridge();
  let rl: readline.Interface | null = null;
  let responseChunks: string[] = [];
  let runningChannel: Channel | null = null;
  let runningPrompt: string | null = null;

  const reprompt = () => rl?.prompt(true);
  const setPrompt = () =>
    rl?.setPrompt(pc.bold(pc.primary(`you [#${active.name}]> `)));

  bridge.on("event", (event: BridgeEvent) => {
    process.stdout.write("\r\x1b[2K");
    switch (event.type) {
      case "text":
        responseChunks.push(event.text);
        process.stdout.write(`${pc.green("opencode>")} ${event.text}\n`);
        break;
      case "tool":
        process.stdout.write(pc.dim(`[tool] ${event.tool}\n`));
        break;
      case "error":
        process.stdout.write(pc.red(`error: ${event.message}\n`));
        break;
      case "done": {
        const response = responseChunks.join("\n\n").trim();
        if (runningChannel && runningPrompt) {
          memory.recordTurn({
            channel: runningChannel.name,
            user: "you",
            prompt: runningPrompt,
            response,
          });
        }
        responseChunks = [];
        runningChannel = null;
        runningPrompt = null;
        process.stdout.write(pc.dim("— done\n"));
        break;
      }
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
    prompt: "",
    historySize: 200,
  });

  const printChannels = () => {
    const channels = store.list();
    if (channels.length === 0) {
      console.log(pc.dim("no channels"));
      return;
    }
    for (const channel of channels) {
      const marker = channel.id === active.id ? pc.primary("*") : " ";
      const name =
        channel.id === active.id
          ? pc.primary(`#${channel.name}`)
          : `#${channel.name}`;
      console.log(`${marker} ${name} ${pc.dim(channel.sessionId)}`);
    }
  };

  const switchTo = (ref: string) => {
    const channel = store.get(ref);
    if (!channel) {
      console.log(pc.red(`unknown channel: ${ref}`));
      return;
    }
    if (channel.archived) {
      console.log(pc.red(`channel #${channel.name} is archived`));
      return;
    }
    active = channel;
    setPrompt();
    console.log(
      pc.primary(`switched to #${channel.name} — session ${channel.sessionId}`),
    );
  };

  console.log(
    pc.dim(
      `OpenCode Duet chat — workspace ${baseSessionId}\n` +
        `channel #${active.name} — session ${active.sessionId}\n` +
        `channels: ${childSessions ? "OpenCode child sessions" : "standalone sessions"}\n` +
        `cwd ${cwd}${model ? ` — model ${model}` : ""}\n` +
        "Type /channels, /new <name>, /switch <name>, /memory or /exit.",
    ),
  );
  setPrompt();
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

    if (text.startsWith("/")) {
      const [command, ...rest] = text.slice(1).split(/\s+/);
      const arg = rest.join(" ").trim();
      switch (command.toLowerCase()) {
        case "exit":
        case "quit":
          exit();
          return;
        case "help":
          console.log(
            [
              pc.bold("commands"),
              "  /channels              list channels",
              "  /new <name>            create a channel (virtual session)",
              "  /switch <name>         switch channel",
              "  /close <name>          archive a channel",
              "  /memory                show shared memory",
              "  /memory add <text>     add a note to shared memory",
              "  /exit                  leave",
            ].join("\n"),
          );
          break;
        case "channels":
          printChannels();
          break;
        case "new": {
          const display =
            arg.trim().replace(/^#/, "").slice(0, 48) ||
            `channel-${store.list().length + 1}`;
          console.log(pc.dim(`creating #${display}…`));
          void (async () => {
            let sessionId: string | undefined;
            try {
              sessionId = await sessions.createChild(
                baseSessionId,
                `#${display}`,
                cwd,
              );
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              console.log(
                pc.yellow(`child session unavailable: ${message}`),
              );
              console.log(pc.dim("using a standalone session"));
            }

            try {
              const channel = store.create(
                display,
                "you",
                undefined,
                sessionId,
              );
              active = channel;
              setPrompt();
              console.log(
                pc.primary(
                  `created #${channel.name} — session ${channel.sessionId}`,
                ),
              );
            } catch (error) {
              if (sessionId) void sessions.remove(sessionId);
              console.log(
                pc.red(error instanceof Error ? error.message : String(error)),
              );
            }
            rl?.prompt();
          })();
          return;
        }
        case "switch":
        case "s":
          if (!arg) {
            console.log(pc.red("usage: /switch <name>"));
            break;
          }
          switchTo(arg);
          break;
        case "close":
        case "archive": {
          if (!arg) {
            console.log(pc.red("usage: /close <name>"));
            break;
          }
          const channel = store.get(arg);
          if (!channel) {
            console.log(pc.red(`unknown channel: ${arg}`));
            break;
          }
          try {
            store.archive(channel.id);
            if (active.id === channel.id) {
              active = store.main;
              setPrompt();
            }
            console.log(pc.dim(`archived #${channel.name}`));
          } catch (error) {
            console.log(
              pc.red(error instanceof Error ? error.message : String(error)),
            );
          }
          break;
        }
        case "memory": {
          if (!arg) {
            console.log(memory.read() || pc.dim("(shared memory is empty)"));
            break;
          }
          const note = arg.replace(/^add\s+/i, "").trim();
          if (!/^add(\s|$)/i.test(arg) || !note) {
            console.log(pc.red("usage: /memory  or  /memory add <text>"));
            break;
          }
          try {
            memory.appendNote(note, "you");
            console.log(pc.dim("note added to shared memory"));
          } catch (error) {
            console.log(
              pc.red(error instanceof Error ? error.message : String(error)),
            );
          }
          break;
        }
        default:
          console.log(pc.red(`unknown command: /${command}`));
          break;
      }
      rl?.prompt();
      return;
    }

    if (bridge.isBusy()) {
      console.log(pc.yellow("opencode is busy; wait for the current turn"));
      rl?.prompt();
      return;
    }

    const channel = active;
    runningChannel = channel;
    runningPrompt = text;
    responseChunks = [];
    void bridge
      .run({
        prompt: memory.decorate(
          channel.name,
          text,
          store.list().length,
        ),
        sessionId: channel.sessionId,
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
