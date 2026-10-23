import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { NotifyConfig } from "./agent/config.js";

const execFileAsync = promisify(execFile);

function escapeAppleScript(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, " ")
    .slice(0, 500);
}

export async function notify(
  config: NotifyConfig,
  title: string,
  message: string,
): Promise<void> {
  const tasks: Array<Promise<unknown>> = [];

  if (config.macos && process.platform === "darwin") {
    const script =
      `display notification "${escapeAppleScript(message)}" ` +
      `with title "${escapeAppleScript(title)}"`;
    tasks.push(
      execFileAsync("osascript", ["-e", script]).catch(() => undefined),
    );
  }

  if (config.webhook) {
    tasks.push(
      fetch(config.webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          message,
          source: "opencode-duet",
          at: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(15_000),
      }).catch(() => undefined),
    );
  }

  await Promise.all(tasks);
}
