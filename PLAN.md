# OpenCode Duet — plan

## Cilj
1. `opencode-duet host` / `join` — deljena OpenCode sesija sa drugom osobom: chat + `@opencode`, kao `claude-duet`.
2. `opencode-duet agent` — proaktivni Duet: dnevni brief, periodične provere, izvori (shell komande), approval red, macOS notifikacije, lokalni dashboard.
3. Kanali (virtualne sesije unutar sesije) — imenovane pod-niti sa sopstvenom OpenCode sesijom i deljenom memorijom, kao Claude Duet channels.

## Status
- [x] Scaffold (package.json, tsconfig, plan)
- [x] OpenCode bridge (`opencode run --format json`, streaming)
- [x] Duet protocol + server + client
- [x] Host/join CLI + readline UI
- [x] Agent config + scheduler + runner + approvals
- [x] Dashboard (briefs + approve/reject)
- [x] Chat sa agent sesijom (`opencode-duet chat`)
- [x] Kanali: `ChannelStore`, per-channel OpenCode sesije, `#main`
- [x] Deljena memorija: beleške + sumari turnova iz drugih kanala
- [x] `/channels`, `/new`, `/switch`, `/close`, `/memory`, `/memory add` (host/join)
- [x] Kanali u `chat` komandi i prikaz na dashboardu
- [x] `opencode-duet channels` CLI
- [x] Tests + build (40 testova prolazi)
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
- Kanali: kreiranje, prebacivanje, izolovana istorija, per-channel OpenCode sesija, deljena memorija, arhiviranje (host).
- Stvarni OpenCode: prompt u `#smoke` je vratio `CHANNEL_SMOKE_OK`, prompt u `#main` `MAIN_SMOKE_OK`; memorija je injektovana.
- UI smoke: host/guest `/new`, `@opencode`, `/channels`, `/close`, `/memory` (`UI_SMOKE_OK`).
- `chat` smoke: kanali, prebacivanje, memorija (`CHAT_SMOKE_OK`).
- Dashboard smoke: kanali u `/api/state` (`DASHBOARD_SMOKE_OK`).

## Odluke
- Node 20+ / TypeScript, dependency: `ws`, `commander`, `picocolors`, `localtunnel`.
- LAN WebSocket po defaultu; `--tunnel localtunnel` ili `--tunnel ngrok`.
- Agent koristi `opencode run --session <id>`; izvori su shell komande; akcije se samo predlažu, izvršavaju se tek posle `approvals approve`.
- Dashboard bind na `127.0.0.1`.
- launchd installer postoji, ali nije instaliran (ne pokretati agenta u pozadini bez korisnikove odluke).
- Kanali: `#main` koristi bazni `--session`; svaki novi kanal dobija `ses_duet_<slug>_<hex>`.
- Deljena memorija se čuva u `workspaces/<session>/memory.json`; u prompt se ubacuje samo kontekst iz drugih kanala + beleške, da se ne ponavlja sopstvena istorija.
- Kanali se čuvaju u `workspaces/<session>/channels.json`; istorija chata je u memoriji procesa, OpenCode sesija nosi sopstveni kontekst.
- Gost može da kreira i menja kanale; arhiviranje je samo za hosta.

## Sledeće (opciono)
- E2E enkripcija za duet sesiju.
- Više gostiju / sobe.
- Ugrađeni OAuth konektori (Gmail/Calendar) umesto shell izvora.
- Dodela agent check-ova kanalima (task po kanalu) i prikaz statusa na dashboardu.
