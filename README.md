# opencode-duet

Two people, one OpenCode session — plus a proactive Duet agent.

`opencode-duet` has two independent modes:

1. **Shared session** — host an OpenCode session, send a join command to a partner, chat in real time, and run `@opencode` prompts together. Think `claude-duet`, but for OpenCode.
2. **Proactive agent** — a local daemon that writes a morning brief, runs periodic checks, collects sources (calendar, Git, GitHub, mail, custom commands), sends macOS/webhook notifications, and queues risky actions for explicit approval.

## Requirements

- Node.js 20+
- [OpenCode](https://opencode.ai) v2+ in `PATH`, already configured with a model
- macOS for notifications and the launchd installer (the CLI itself works on Linux too)
- Optional: `ngrok` for a custom tunnel, `icalBuddy`/`gh`/`himalaya` for richer sources

## Install

```bash
git clone <this-repo> ~/Projects/opencode-duet
cd ~/Projects/opencode-duet
npm install
npm run build
npm link
```

If `opencode-duet` is not found after `npm link`, the npm global bin directory is not in your `PATH`. Link it manually:

```bash
ln -sf "$(pwd)/dist/index.js" ~/.local/bin/opencode-duet
```

Verify:

```bash
opencode-duet --version
```

## Mode 1 — Shared OpenCode session

### Host

```bash
opencode-duet host --name Alice
```

The host prints a ready-to-send join command:

```text
opencode-duet join ws://192.168.1.2:54321 --password 1a2b3c4d --name guest
```

Options:

```text
--name <name>          display name
--port <port>          fixed port (default: random)
--password <password>  fixed password (default: random)
--session <id>         OpenCode session id to use or create
--model <model>        OpenCode model, e.g. provider/model
--agent <agent>        OpenCode agent name
--cwd <dir>            working directory for OpenCode
--auto                 no approval gates (guest prompts + OpenCode tools)
--tunnel <provider>    none | localtunnel | ngrok
```

### Join

```bash
opencode-duet join ws://192.168.1.2:54321 --password 1a2b3c4d --name Bob
```

### Chat commands

| Input | What it does |
| --- | --- |
| `hello` | chat with the other person |
| `@opencode fix the failing test` | send a prompt to the shared OpenCode session |
| `/approve <id> y` | host approves a guest prompt |
| `/approve <id> n` | host denies a guest prompt |
| `/auto on` / `/auto off` | toggle guest approval mode |
| `/status` | connection and approval status |
| `/exit` | leave |

Guest prompts are **held for host approval by default**. The host sees the full prompt and an approval id. With `--auto`, guest prompts run immediately.

### Remote partner

LAN is the default. For a partner on another network:

```bash
opencode-duet host --tunnel localtunnel
```

`localtunnel` needs no account and gives a public `https://…loca.lt` URL. The join command is printed automatically.

`ngrok` works too, but needs a one-time token:

```bash
ngrok config add-authtoken <token>
opencode-duet host --tunnel ngrok
```

## Mode 2 — Proactive Duet agent

### Initialize

```bash
opencode-duet agent init
opencode-duet agent config
```

Config lives at `~/.config/opencode-duet/agent.json`.

### Run a brief now

```bash
opencode-duet brief
```

The result is printed, saved under `~/.local/state/opencode-duet/briefs/`, and sent as a macOS notification (unless disabled).

### Start the scheduler

```bash
opencode-duet agent start
```

This runs in the foreground. To start it at login and keep it alive on macOS:

```bash
opencode-duet agent install
```

Remove it with:

```bash
opencode-duet agent uninstall
```

### Dashboard

```bash
opencode-duet dashboard
```

Opens `http://127.0.0.1:8787` with recent briefs, pending approvals, Approve/Reject buttons, and a **Run brief now** button. The server binds to localhost only.

### Chat with the agent

```bash
opencode-duet chat
```

Opens a small terminal chat against the same OpenCode session the agent uses (`ses_duet_agent` by default). Use `/new` for a fresh session and `/exit` to leave. This is optional — you can also open the session in the OpenCode TUI.

### Approvals

The agent never executes risky actions itself. It proposes them in a fenced block:

````markdown
```duet-action
{"type":"shell","title":"Open the PR page","command":"gh pr view 42 --web","reason":"You asked for the PR link"}
```
````

Proposals are stored in `~/.local/state/opencode-duet/approvals.json`.

```bash
opencode-duet approvals list
opencode-duet approvals approve ap-1a2b3c4d
opencode-duet approvals reject ap-1a2b3c4d
```

Supported action types:

- `shell` — runs the command with `/bin/bash` after approval
- `webhook` — POSTs JSON to a URL after approval

### Config example

```json
{
  "version": 1,
  "name": "Duet",
  "cwd": "~/Projects",
  "model": "freellmapi/auto:keyless",
  "session": "ses_duet_agent",
  "brief": {
    "enabled": true,
    "at": "08:00",
    "prompt": "Napravi kratak jutarnji brief na srpskom. Izvuci samo ono što je danas važno: obaveze, rokove, otvorene PR-ove, probleme i sledeću konkretnu akciju."
  },
  "checks": [
    {
      "name": "inbox",
      "every": "2h",
      "prompt": "Proveri da li ima nečega što traži moju pažnju. Ako nema, odgovori tačno: NO_ACTION"
    }
  ],
  "sources": [
    { "name": "calendar", "command": "icalBuddy -n -nc eventsToday 2>/dev/null || true" },
    { "name": "github", "command": "gh pr list --limit 5 2>/dev/null || true" },
    { "name": "git", "command": "git -C ~/Projects/opencode-duet status --short --branch 2>/dev/null || true" }
  ],
  "notify": { "macos": true, "webhook": "" },
  "approvals": { "enabled": true }
}
```

Sources are arbitrary shell commands. Their output is injected into the prompt as data, not instructions. A failing source is included as `(source failed) …` and never stops the brief.

`every` accepts `30m`, `2h`, `1d`. `at` is local time in `HH:MM`.

### Status

```bash
opencode-duet agent status
```

Shows config, schedule, pending approvals, state and log paths.

## How it works

- The shared session uses a small WebSocket relay hosted by the host. The guest connects with a password; the host remains the only machine running OpenCode.
- Each `@opencode` prompt is executed with:

  ```bash
  opencode run --format json --session <id> -- <prompt>
  ```

  JSON events (`text`, `tool_use`, `step_finish`) are streamed to both people.
- The agent uses the same bridge with a dedicated session id (`ses_duet_agent` by default). It collects sources, runs the prompt, saves the brief, parses `duet-action` blocks, and queues approvals.
- macOS notifications use `osascript`; webhooks use `fetch`.
- The launchd installer writes `~/Library/LaunchAgents/com.opencode-duet.agent.plist`.

## Security

- Guest prompts require host approval unless you explicitly pass `--auto`.
- The agent only **proposes** actions. Nothing runs until `approvals approve` or the dashboard button is clicked.
- The dashboard binds to `127.0.0.1`.
- LAN/tunnel traffic is protected by the join password and TLS from localtunnel/ngrok. There is no end-to-end encryption layer yet; for sensitive work use LAN, Tailscale, or an SSH tunnel.
- `--auto` also passes `--auto` to OpenCode, which auto-approves tool permissions. Use it only with people you trust.
- The agent runs OpenCode without `--auto`; it is intended for read-only briefs and checks.

## Development

```bash
npm install
npm run build
npm test
```

Tests cover the protocol, scheduler, approval store, WebSocket server/client, and an end-to-end agent run with a fake `opencode` binary.

## Limitations

- The agent runs on your machine, not in a cloud VM; it pauses when the machine sleeps.
- Sources are shell commands, not OAuth connectors. Calendar/mail/GitHub integrations depend on the CLIs you have installed.
- One guest per host session.
- No built-in end-to-end encryption.

## License

MIT
