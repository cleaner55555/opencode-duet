# OpenCode Duet — plan

## Cilj
1. `opencode-duet host` / `join` — deljena OpenCode sesija sa drugom osobom: chat + `@opencode`, kao `claude-duet`.
2. `opencode-duet agent` — proaktivni Duet: dnevni brief, periodične provere, izvori (shell komande), approval red, macOS notifikacije, lokalni dashboard.

## Status
- [x] Scaffold (package.json, tsconfig, plan)
- [x] OpenCode bridge (`opencode run --format json`, streaming)
- [x] Duet protocol + server + client
- [x] Host/join CLI + readline UI
- [x] Agent config + scheduler + runner + approvals
- [x] Dashboard (briefs + approve/reject)
- [x] Chat sa agent sesijom (`opencode-duet chat`)
- [x] Tests + build (21 testova prolazi)
- [x] Global install (`~/.local/bin/opencode-duet`) + smoke testovi
- [x] README + LICENSE

## Šta je testirano
- Host/guest chat preko LAN WebSocketa.
- Guest prompt → host approval → OpenCode stream (`DUET_DUET_OK`).
- Localtunnel javni URL + WSS join (`TUNNEL_SMOKE_OK`).
- Agent brief preko stvarnog OpenCode (`DUET_AGENT_OK`).
- CLI approvals: approve izvršava shell akciju (`cli-ok`).
- Dashboard API: state, brief, approve.
- `agent start` se čisto gasi na SIGINT.

## Odluke
- Node 20+ / TypeScript, dependency: `ws`, `commander`, `picocolors`, `localtunnel`.
- LAN WebSocket po defaultu; `--tunnel localtunnel` ili `--tunnel ngrok`.
- Agent koristi `opencode run --session <id>`; izvori su shell komande; akcije se samo predlažu, izvršavaju se tek posle `approvals approve`.
- Dashboard bind na `127.0.0.1`.
- launchd installer postoji, ali nije instaliran (ne pokretati agenta u pozadini bez korisnikove odluke).

## Sledeće (opciono)
- E2E enkripcija za duet sesiju.
- Više gostiju / sobe.
- Ugrađeni OAuth konektori (Gmail/Calendar) umesto shell izvora.
