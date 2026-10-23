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
- [x] Kanali kao native OpenCode child sesije pod baznom sesijom (`parentID`)
- [x] Fallback na standalone sesiju + notice kada OpenCode API nije dostupan
- [x] Deljena memorija: beleške + sumari turnova iz drugih kanala
- [x] `/channels`, `/new`, `/switch`, `/close`, `/memory`, `/memory add` (host/join)
- [x] Kanali u `chat` komandi i prikaz na dashboardu
- [x] `opencode-duet channels` CLI
- [x] Boje usklađene sa OpenCode default temom (CLI + dashboard)
- [x] Tests + build (43 testa prolazi)
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
- Native child sesija: `ensureBase` + `createChild`, dete ima `parentID` bazne sesije, ne pojavljuje se u `opencode session list` (`CHILD_SMOKE_OK`).
- Stvarni prompt u child sesiji kroz `DuetServer` (`CHILD_PROMPT_SMOKE_OK`).
- UI smoke: host/guest `/new`, `@opencode`, `/channels`, `/close`, `/memory` (`UI_SMOKE_OK`).
- `chat` smoke: kanali, prebacivanje, memorija (`CHAT_SMOKE_OK`).
- Dashboard smoke: kanali u `/api/state` (`DASHBOARD_SMOKE_OK`).

## Odluke
- Node 20+ / TypeScript, dependency: `ws`, `commander`, `picocolors`, `localtunnel`.
- LAN WebSocket po defaultu; `--tunnel localtunnel` ili `--tunnel ngrok`.
- Agent koristi `opencode run --session <id>`; izvori su shell komande; akcije se samo predlažu, izvršavaju se tek posle `approvals approve`.
- Dashboard bind na `127.0.0.1`.
- launchd installer postoji, ali nije instaliran (ne pokretati agenta u pozadini bez korisnikove odluke).
- Kanali: `#main` koristi bazni `--session`; svaki novi kanal se kreira kao OpenCode child sesija pod baznom sesijom preko `POST /api/session` sa `parentID`. Ako API nije dostupan, fallback je `ses_duet_<slug>_<hex>` standalone sesija uz notice.
- Deljena memorija se čuva u `workspaces/<session>/memory.json`; u prompt se ubacuje samo kontekst iz drugih kanala + beleške, da se ne ponavlja sopstvena istorija.
- Kanali se čuvaju u `workspaces/<session>/channels.json`; istorija chata je u memoriji procesa, OpenCode sesija nosi sopstveni kontekst.
- Gost može da kreira i menja kanale; arhiviranje je samo za hosta.
- Boje: OpenCode default dark tema (`#fab283` primary, `#5c9cf5` secondary, `#9d7cd8` accent, `#7fd88f` success, `#e06c75` error, `#f5a742` warning, `#56b6c2` info, `#eeeeee` text, `#808080` muted, `#0a0a0a` bg, `#141414` panel, `#484848` border). CLI koristi truecolor ako terminal to podržava, inače 256-color fallback; dashboard koristi iste vrednosti kroz CSS varijable.

## Sledeće (opciono)
- E2E enkripcija za duet sesiju.
- Više gostiju / sobe.
- Ugrađeni OAuth konektori (Gmail/Calendar) umesto shell izvora.
- Dodela agent check-ova kanalima (task po kanalu) i prikaz statusa na dashboardu.
