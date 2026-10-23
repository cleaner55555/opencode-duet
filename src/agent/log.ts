import fs from "node:fs";
import { LOG_FILE, ensureDirs } from "../paths.js";

export function log(message: string): void {
  ensureDirs();
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line, "utf8");
  } catch {
    // Logging must never crash the agent.
  }
}
