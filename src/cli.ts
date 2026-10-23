#!/usr/bin/env node
import { Command } from "commander";
import pc from "picocolors";
import { guestCommand } from "./duet/guest.js";
import { hostCommand } from "./duet/host.js";
import {
  agentStatus,
  installLaunchAgent,
  printConfig,
  runAgentOnce,
  startAgent,
  uninstallLaunchAgent,
  writeDefaultConfig,
} from "./agent/daemon.js";
import { ApprovalStore, formatApproval } from "./agent/approvals.js";
import { loadAgentConfig } from "./agent/config.js";
import { CONFIG_FILE, workspaceFile } from "./paths.js";
import { ChannelStore } from "./duet/channels.js";
import { chatCommand } from "./chat.js";
import { startDashboard } from "./dashboard.js";

export async function runCli(argv: string[]): Promise<void> {
  const program = new Command();

  program
    .name("opencode-duet")
    .description(
      "Two people, one OpenCode session — plus a proactive Duet agent.",
    )
    .version("0.2.0");

  program
    .command("host")
    .description("start a shared OpenCode session and print a join command")
    .option("-n, --name <name>", "your display name")
    .option("-p, --port <port>", "port to listen on", "0")
    .option("--password <password>", "join password (random by default)")
    .option("--session <id>", "OpenCode session id to use/create")
    .option("--model <model>", "OpenCode model (provider/model)")
    .option("--agent <agent>", "OpenCode agent name")
    .option("--cwd <dir>", "working directory for OpenCode")
    .option("--auto", "auto-approve guest prompts")
    .option("--tunnel <provider>", "ngrok or none", "none")
    .action(async (options) => {
      await hostCommand(options);
    });

  program
    .command("join")
    .description("join a shared OpenCode session")
    .argument("<url>", "ws:// or wss:// URL from the host")
    .option("--password <password>", "join password")
    .option("-n, --name <name>", "your display name")
    .action(async (url, options) => {
      await guestCommand(url, options);
    });

  program
    .command("brief")
    .description("run the morning brief now")
    .option("--config <file>", "agent config file")
    .action(async (options) => {
      await runAgentOnce({ config: options.config });
    });

  program
    .command("channels")
    .description("list channels (virtual sessions) in a Duet workspace")
    .option("--session <id>", "base OpenCode session id")
    .option("--config <file>", "agent config file")
    .option("--all", "include archived channels")
    .action((options) => {
      const config = loadAgentConfig(options.config ?? CONFIG_FILE);
      const base = options.session?.trim() || config.session;
      const store = new ChannelStore(
        workspaceFile(base, "channels.json"),
        base,
      );
      const channels = store.list(Boolean(options.all));
      if (channels.length === 0) {
        console.log(pc.dim("no channels"));
        return;
      }
      for (const channel of channels) {
        const marker = channel.id === "main" ? "*" : " ";
        const archived = channel.archived ? pc.dim(" (archived)") : "";
        console.log(
          `${marker} #${channel.name}${archived} ${pc.dim(channel.sessionId)}`,
        );
      }
    });

  program
    .command("chat")
    .description("chat with the Duet agent session")
    .option("--session <id>", "OpenCode session id")
    .option("--model <model>", "OpenCode model (provider/model)")
    .option("--agent <agent>", "OpenCode agent name")
    .option("--cwd <dir>", "working directory for OpenCode")
    .option("--config <file>", "agent config file")
    .option("--auto", "auto-approve OpenCode tools")
    .action(async (options) => {
      await chatCommand(options);
    });

  program
    .command("dashboard")
    .description("open a local dashboard for briefs and approvals")
    .option("-p, --port <port>", "port to listen on", "8787")
    .option("--config <file>", "agent config file")
    .option("--no-open", "do not open the browser")
    .action(async (options) => {
      await startDashboard({
        port: Number(options.port),
        config: options.config,
        open: options.open,
      });
    });

  const agent = program
    .command("agent")
    .description("proactive Duet agent (briefs, checks, approvals)");

  agent
    .command("start")
    .description("start the scheduler in the foreground")
    .option("--config <file>", "agent config file")
    .action(async (options) => {
      await startAgent({ config: options.config });
    });

  agent
    .command("once")
    .description("run the brief or a named check once")
    .option("--config <file>", "agent config file")
    .option("--check <name>", "run this check instead of the brief")
    .action(async (options) => {
      await runAgentOnce({ config: options.config, check: options.check });
    });

  agent
    .command("status")
    .description("show config, schedule and pending approvals")
    .option("--config <file>", "agent config file")
    .action((options) => {
      agentStatus({ config: options.config });
    });

  agent
    .command("install")
    .description("install a macOS launch agent (starts at login)")
    .option("--config <file>", "agent config file")
    .action(async (options) => {
      await installLaunchAgent({ config: options.config });
    });

  agent
    .command("uninstall")
    .description("remove the macOS launch agent")
    .action(async () => {
      await uninstallLaunchAgent();
    });

  agent
    .command("config")
    .description("print the agent config")
    .option("--config <file>", "agent config file")
    .action((options) => {
      printConfig({ config: options.config });
    });

  agent
    .command("init")
    .description("write the default agent config")
    .option("--config <file>", "agent config file")
    .action((options) => {
      writeDefaultConfig({ config: options.config });
    });

  const approvals = program
    .command("approvals")
    .description("review actions proposed by the agent");

  approvals
    .command("list")
    .description("list approvals")
    .option("--all", "include done and rejected")
    .option("--status <status>", "pending, done, rejected or failed")
    .action((options) => {
      const store = new ApprovalStore();
      const items = options.all
        ? store.list()
        : store.list(options.status ?? "pending");
      if (items.length === 0) {
        console.log(pc.dim("no approvals"));
        return;
      }
      for (const approval of items) {
        console.log(formatApproval(approval));
        console.log("");
      }
    });

  approvals
    .command("approve")
    .description("approve and execute an action")
    .argument("<id>", "approval id or prefix")
    .action(async (id) => {
      const store = new ApprovalStore();
      const approval = await store.approve(id);
      console.log(formatApproval(approval));
    });

  approvals
    .command("reject")
    .description("reject an action")
    .argument("<id>", "approval id or prefix")
    .action((id) => {
      const store = new ApprovalStore();
      console.log(formatApproval(store.reject(id)));
    });

  await program.parseAsync(argv);
}
