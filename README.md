# opencode-duet

Two people, one OpenCode session — plus a proactive Duet agent.

`opencode-duet` has two independent modes:

1. **Shared session** — host an OpenCode session, send a join command to a partner, chat in real time, run `@opencode` prompts together, and split work into named channels (virtual sessions inside the session). Think `claude-duet`, but for OpenCode.
2. **Proactive agent** — a local daemon that writes a morning brief, runs periodic checks, collects sources (calendar, Git, GitHub, mail, custom commands), sends macOS/webhook notifications, and queues risky actions for explicit approval.

## Requirements

- Node.js 20+
- [OpenCode](https://opencode.ai) v2.1+ in `PATH`, already configured with a model (native child sessions use `opencode api`; older versions fall back to standalone channel sessions)
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
| `hello` | chat with the other person in the active channel |
| `@opencode fix the failing test` | send a prompt to the active channel |
| `/channels` | list channels and their message counts |
| `/new <name>` | create a channel and switch to it |
| `/switch <name>` | switch the active channel |
| `/close <name>` | host archives a channel |
| `/memory` | show shared memory |
| `/memory add <text>` | add a note to shared memory |
| `/approve <id> y` | host approves a guest prompt |
| `/approve <id> n` | host denies a guest prompt |
| `/auto on` / `/auto off` | toggle guest approval mode |
| `/status` | connection and approval status |
| `/exit` | leave |

Guest prompts are **held for host approval by default**. The host sees the full prompt and an approval id. With `--auto`, guest prompts run immediately.

### Channels (virtual sessions)

Channels are named sub-threads inside one Duet workspace, similar to Slack channels or Claude Duet channels:

- Every channel has its own OpenCode session, so a long task in `#sales` does not fill the main thread's context.
- New channels are native OpenCode **child sessions** under the base Duet session (`parentID`). OpenCode keeps them grouped under the parent and `opencode session list` still shows only top-level sessions. If the OpenCode API is unavailable, Duet falls back to a standalone session and tells you.
- `#main` is the base session itself; `/new` creates a child session for every other channel.
- All channels share memory. Notes from `/memory add` and short summaries of turns from other channels are injected into each prompt.
- Each person has their own active channel; messages and OpenCode output are scoped to it. Activity in another channel is shown dimmed, e.g. `[#sales] → Guest: …`.
- Channels are stored under `~/.local/state/opencode-duet/workspaces/<session>/`. Use `--session <id>` on the host if you want to keep the same channels across restarts.
- The host can archive a channel with `/close`; the main channel cannot be archived.

Example:

```text
/new sales
@opencode prepare the Q4 pipeline report

/switch main
@opencode summarize what changed in #sales
```

The second prompt sees the shared memory summary from `#sales`, even though it runs in the main OpenCode session.

List channels from a terminal:

```bash
opencode-duet channels --session <id>
opencode-duet channels --session <id> --all   # include archived
```

The list prints each channel's OpenCode session id. To review a channel directly in OpenCode, open that session:

```bash
opencode --session <child-session-id>
```

The base session remains the parent, and the channel sessions are grouped under it in OpenCode's session data.

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

Opens `http://127.0.0.1:8787` with channels, recent briefs, pending approvals, Approve/Reject buttons, and a **Run brief now** button. The server binds to localhost only.

The CLI and dashboard use OpenCode's default dark theme (`opencode`): primary orange `#fab283`, secondary blue `#5c9cf5`, accent purple `#9d7cd8`, success green `#7fd88f`, error red `#e06c75`, warning orange `#f5a742`, info cyan `#56b6c2`, text `#eeeeee`, muted `#808080`, background `#0a0a0a`, panel `#141414`, border `#484848`. The CLI emits truecolor when the terminal advertises it and falls back to 256-color approximations otherwise.

A **Light/Dark** button in the dashboard header switches between OpenCode's dark and light palettes. The choice is stored in `localStorage` and restored on reload.

### Chat with the agent

```bash
opencode-duet chat
```

Opens a small terminal chat against the same OpenCode workspace the agent uses (`ses_duet_agent` by default). `/new <name>` creates a channel as an OpenCode child session under that workspace, `/switch <name>` moves between channels, `/memory` shows shared memory, and `/exit` leaves. This is optional — you can also open the base session in the OpenCode TUI and review its child sessions there.

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
- Each channel maps to a separate OpenCode session. The main channel uses the host's base `--session` id; new channels get ids like `ses_duet_sales_1a2b3c4d`.
- Each `@opencode` prompt is executed with:

  ```bash
  opencode run --format json --session <channel-session> -- <prompt>
  ```

  JSON events (`text`, `tool_use`, `step_finish`) are streamed to the active channel.
- Before a prompt is sent, the shared-memory block is prepended: notes plus short summaries of turns from other channels. Channel transcripts stay in their own OpenCode sessions.
- Channel metadata and shared memory are persisted as JSON under `~/.local/state/opencode-duet/workspaces/<session>/`.
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

Tests cover the protocol, channel store, shared memory, scheduler, approval store, WebSocket server/client, channel routing, and an end-to-end agent run with a fake `opencode` binary.

## Limitations

- The agent runs on your machine, not in a cloud VM; it pauses when the machine sleeps.
- Sources are shell commands, not OAuth connectors. Calendar/mail/GitHub integrations depend on the CLIs you have installed.
- One guest per host session.
- Channel chat history is kept in memory for the current process; the channel's OpenCode session and shared memory persist, so the assistant keeps its context across restarts.
- No built-in end-to-end encryption.

## License

MIT
