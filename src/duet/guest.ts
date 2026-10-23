import pc from "picocolors";
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

  console.log(pc.dim(`connecting to ${url}…`));
  const joined = await client.connect(url);
  console.log(
    pc.green(
      `joined ${joined.sessionId} — host ${joined.hostUser} — approval ${
        joined.approvalMode ? "on" : "off"
      }`,
    ),
  );

  const ui = createUi({
    name,
    role: "guest",
    onChat: (text) => client.sendChat(text),
    onPrompt: (text) => client.sendPrompt(text),
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

  client.on("message", (message: ServerMessage) => ui.print(message));
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
