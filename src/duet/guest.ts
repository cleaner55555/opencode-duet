import { oc as pc } from "../theme.js";
import { DuetClient } from "./client.js";
import { createUi } from "./ui.js";
import type { ServerMessage } from "./protocol.js";

export interface GuestOptions {
  password?: string;
  name?: string;
}

export async function guestCommand(
  url: string,
  options: GuestOptions,
): Promise<void> {
  if (!options.password) {
    throw new Error("Missing --password (copy the join command from the host)");
  }

  const name = options.name?.trim() || "guest";
  const client = new DuetClient(name, options.password);

  // The server sends channel history right after join_accepted, before the UI
  // exists. Buffer those messages and replay them once the UI is ready.
  const buffered: ServerMessage[] = [];
  const buffer = (message: ServerMessage) => {
    if (message.type === "join_accepted" || message.type === "join_rejected") {
      return;
    }
    buffered.push(message);
  };
  client.on("message", buffer);

  console.log(pc.dim(`connecting to ${url}…`));
  const joined = await client.connect(url);
  client.off("message", buffer);
  console.log(
    pc.green(
      `joined ${joined.sessionId} — host ${joined.hostUser} — approval ${
        joined.approvalMode ? "on" : "off"
      } — channel #${joined.activeChannel}`,
    ),
  );

  const ui = createUi({
    name,
    role: "guest",
    onChat: (text) => client.sendChat(text),
    onPrompt: (text) => client.sendPrompt(text),
    onSwitchChannel: (channel) => client.sendSwitchChannel(channel),
    onCreateChannel: (channelName) => client.sendCreateChannel(channelName),
    onChannels: () => client.sendChannelsRequest(),
    onMemory: () => client.sendMemoryRequest(),
    onMemoryAdd: (text) => client.sendMemoryAdd(text),
    onExit: () => {
      client.close();
      process.exit(0);
    },
    status: () =>
      pc.dim(
        `guest ${name} — session ${joined.sessionId} — host ${joined.hostUser} — approval ${
          joined.approvalMode ? "on" : "off"
        }`,
      ),
  });

  ui.print({
    type: "channels",
    channels: joined.channels,
    active: joined.activeChannel,
    timestamp: Date.now(),
  });
  client.on("message", (message: ServerMessage) => ui.print(message));
  for (const message of buffered) ui.print(message);
  client.on("disconnected", () => {
    ui.print({
      type: "error",
      message: "disconnected from host",
      timestamp: Date.now(),
    });
    setTimeout(() => process.exit(1), 50);
  });

  process.on("SIGINT", () => {
    client.close();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    client.close();
    process.exit(0);
  });
}
