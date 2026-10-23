import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import pc from "picocolors";
import { CONFIG_FILE, LOG_FILE, STATE_DIR, ensureDirs, expandHome } from "../paths.js";
import { ApprovalStore, formatApproval } from "./approvals.js";
import {
  initConfig,
  loadAgentConfig,
  saveConfig,
  type AgentConfig,
} from "./config.js";
import { log } from "./log.js";
import { runBrief, runCheck, type TaskResult } from "./runner.js";
import { Scheduler } from "./scheduler.js";

const execFileAsync = promisify(execFile);

export interface AgentOptions {
  config?: string;
}

function configPath(options: AgentOptions): string {
  return options.config ? path.resolve(expandHome(options.config)) : CONFIG_FILE;
}

export async function startAgent(options: AgentOptions = {}): Promise<void> {
  const file = configPath(options);
  const config = initConfig(file);
  ensureDirs();

  const scheduler = new Scheduler(config, {
    onBrief: async () => {
      const result = await runBrief(config);
      console.log(pc.green(`\n[brief] ${result.briefPath}`));
      console.log(result.text);
      if (result.approvals.length) {
        console.log(
          pc.yellow(
            `\n${result.approvals.length} action(s) waiting: opencode-duet approvals list`,
          ),
        );
      }
    },
    onCheck: async (check) => {
      const result = await runCheck(config, check);
      console.log(pc.green(`\n[check:${check.name}] ${result.briefPath}`));
      console.log(result.text);
    },
    onLog: (message) => {
      log(message);
      if (process.env.OPENCODE_DUET_DEBUG) console.log(pc.dim(message));
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      log(`error: ${message}`);
      console.error(pc.red(`error: ${message}`));
    },
  });

  console.log(pc.bold(pc.green("OpenCode Duet agent")));
  console.log(`  config:  ${file}`);
  console.log(`  session: ${config.session}`);
  console.log(`  cwd:     ${expandHome(config.cwd)}`);
  console.log(`  model:   ${config.model ?? "(OpenCode default)"}`);
  console.log("");
  console.log(scheduler.status());
  console.log(pc.dim(`\nlog: ${LOG_FILE}`));
  console.log(pc.dim("Ctrl+C to stop."));

  scheduler.start();
  log("agent started");

  const stop = () => {
    scheduler.stop();
    log("agent stopped");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await new Promise<void>(() => {
    // Keep the process alive; timers do the work.
  });
}

export async function runAgentOnce(
  options: AgentOptions & { check?: string } = {},
): Promise<void> {
  const file = configPath(options);
  const config = initConfig(file);
  let result: TaskResult;
  if (options.check) {
    const check = config.checks.find((item) => item.name === options.check);
    if (!check) {
      const available = config.checks.map((item) => item.name).join(", ") || "none";
      throw new Error(
        `Unknown check "${options.check}" (available: ${available})`,
      );
    }
    result = await runCheck(config, check);
  } else {
    result = await runBrief(config);
  }

  console.log(pc.bold(result.title));
  console.log(result.text);
  console.log(pc.dim(`\nsaved: ${result.briefPath}`));
  if (result.approvals.length) {
    console.log(
      pc.yellow(
        `${result.approvals.length} action(s) queued — opencode-duet approvals list`,
      ),
    );
  }
}

export function agentStatus(options: AgentOptions = {}): void {
  const file = configPath(options);
  const config = loadAgentConfig(file);
  const store = new ApprovalStore();
  const pending = store.list("pending");
  const scheduler = new Scheduler(config, {
    onBrief: async () => {},
    onCheck: async () => {},
  });

  console.log(pc.bold("OpenCode Duet agent status"));
  console.log(`  config:  ${file}`);
  console.log(`  session: ${config.session}`);
  console.log(`  cwd:     ${expandHome(config.cwd)}`);
  console.log(`  model:   ${config.model ?? "(OpenCode default)"}`);
  console.log(`  notify:  macos=${config.notify.macos} webhook=${config.notify.webhook ? "yes" : "no"}`);
  console.log("");
  console.log(scheduler.status());
  console.log("");
  console.log(`pending approvals: ${pending.length}`);
  for (const approval of pending.slice(0, 10)) {
    console.log(pc.yellow(formatApproval(approval)));
  }
  console.log(pc.dim(`state: ${STATE_DIR}`));
  console.log(pc.dim(`log:   ${LOG_FILE}`));
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function launchAgentPath(): string {
  return path.join(
    os.homedir(),
    "Library",
    "LaunchAgents",
    "com.opencode-duet.agent.plist",
  );
}

function cliEntry(): string {
  const entry = process.argv[1];
  if (!entry) throw new Error("Cannot determine CLI entry point");
  return fs.realpathSync(entry);
}

export async function installLaunchAgent(options: AgentOptions = {}): Promise<void> {
  const file = configPath(options);
  const config = initConfig(file);
  ensureDirs();

  const plistPath = launchAgentPath();
  const entry = cliEntry();
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.opencode-duet.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(process.execPath)}</string>
    <string>${escapeXml(entry)}</string>
    <string>agent</string>
    <string>start</string>
    <string>--config</string>
    <string>${escapeXml(file)}</string>
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(expandHome(config.cwd))}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escapeXml(path.join(STATE_DIR, "logs", "launchd.out.log"))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(path.join(STATE_DIR, "logs", "launchd.err.log"))}</string>
</dict>
</plist>
`;

  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, plist, "utf8");

  const uid = process.getuid?.() ?? 501;
  await execFileAsync("launchctl", ["bootout", `gui/${uid}`, plistPath]).catch(
    () => undefined,
  );
  await execFileAsync("launchctl", ["bootstrap", `gui/${uid}`, plistPath]).catch(
    async () => {
      await execFileAsync("launchctl", ["load", "-w", plistPath]);
    },
  );

  console.log(pc.green(`installed ${plistPath}`));
  console.log(pc.dim("agent starts at login and stays running"));
}

export async function uninstallLaunchAgent(): Promise<void> {
  const plistPath = launchAgentPath();
  const uid = process.getuid?.() ?? 501;
  await execFileAsync("launchctl", ["bootout", `gui/${uid}`, plistPath]).catch(
    () => undefined,
  );
  if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
  console.log(pc.green("launch agent removed"));
}

export function printConfig(options: AgentOptions = {}): void {
  const file = configPath(options);
  const config = loadAgentConfig(file);
  console.log(`# ${file}`);
  console.log(JSON.stringify(config, null, 2));
}

export function writeDefaultConfig(options: AgentOptions = {}): void {
  const file = configPath(options);
  if (fs.existsSync(file)) {
    console.log(pc.yellow(`config already exists: ${file}`));
    return;
  }
  const config = initConfig(file);
  saveConfig(config, file);
  console.log(pc.green(`wrote ${file}`));
}
