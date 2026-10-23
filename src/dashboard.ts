import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import pc from "picocolors";
import { BRIEFS_DIR, CONFIG_FILE, workspaceFile } from "./paths.js";
import { ChannelStore } from "./duet/channels.js";
import { ApprovalStore, formatApproval } from "./agent/approvals.js";
import { loadAgentConfig } from "./agent/config.js";
import { runBrief, runCheck } from "./agent/runner.js";
import { Scheduler } from "./agent/scheduler.js";

const execFileAsync = promisify(execFile);

export interface DashboardOptions {
  port?: number;
  open?: boolean;
  config?: string;
}

function briefInfo(file: string): { file: string; title: string; created: string } {
  try {
    const text = fs.readFileSync(path.join(BRIEFS_DIR, file), "utf8");
    const title =
      /^title:\s*"?(.*?)"?\s*$/m.exec(text)?.[1]?.trim() ?? file;
    const created = /^created:\s*(.*?)\s*$/m.exec(text)?.[1]?.trim() ?? "";
    return { file, title, created };
  } catch {
    return { file, title: file, created: "" };
  }
}

function listBriefs(): Array<{ file: string; title: string; created: string }> {
  if (!fs.existsSync(BRIEFS_DIR)) return [];
  return fs
    .readdirSync(BRIEFS_DIR)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .reverse()
    .slice(0, 30)
    .map(briefInfo);
}

function safeBrief(file: string): string | null {
  const name = path.basename(file);
  if (!name.endsWith(".md")) return null;
  const full = path.join(BRIEFS_DIR, name);
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full, "utf8");
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

let runningBrief = false;

function page(): string {
  return `<!doctype html>
<html lang="sr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenCode Duet</title>
<style>
  :root { color-scheme: dark; --bg:#0d1117; --panel:#161b22; --line:#30363d; --fg:#e6edf3; --dim:#8b949e; --green:#3fb950; --red:#f85149; --yellow:#d29922; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background:var(--bg); color:var(--fg); }
  header { padding:18px 22px; border-bottom:1px solid var(--line); display:flex; gap:16px; align-items:baseline; }
  header h1 { font-size:18px; margin:0; }
  header span { color:var(--dim); font-size:12px; }
  main { display:grid; grid-template-columns: 320px 1fr; min-height:calc(100vh - 62px); }
  aside { border-right:1px solid var(--line); padding:16px; overflow:auto; }
  section { padding:16px 22px; overflow:auto; }
  h2 { font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:var(--dim); margin:18px 0 8px; }
  button { background:#21262d; color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:5px 10px; cursor:pointer; font:inherit; }
  button:hover { border-color:#8b949e; }
  button.green { color:var(--green); }
  button.red { color:var(--red); }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:10px 12px; margin-bottom:8px; }
  .card .title { font-weight:600; }
  .card .meta { color:var(--dim); font-size:12px; margin-top:2px; }
  .brief { cursor:pointer; }
  .brief:hover { border-color:#8b949e; }
  .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  pre { white-space:pre-wrap; word-break:break-word; background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
  .muted { color:var(--dim); }
  .pill { display:inline-block; padding:1px 7px; border-radius:999px; border:1px solid var(--line); font-size:11px; color:var(--dim); }
  .pill.pending { color:var(--yellow); border-color:var(--yellow); }
  .pill.done { color:var(--green); border-color:var(--green); }
  .pill.failed, .pill.rejected { color:var(--red); border-color:var(--red); }
</style>
</head>
<body>
<header>
  <h1>OpenCode Duet</h1>
  <span id="status">loading…</span>
</header>
<main>
  <aside>
    <h2>Channels</h2>
    <div id="channels"></div>
    <h2>Briefs</h2>
    <div id="briefs"></div>
  </aside>
  <section>
    <div class="row">
      <button id="run-brief">Run brief now</button>
      <span class="muted" id="run-status"></span>
    </div>
    <h2>Pending approvals</h2>
    <div id="approvals"></div>
    <h2>Brief</h2>
    <pre id="view">Izaberi brief sa leve strane.</pre>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
let state = null;

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function esc(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

async function refresh() {
  try {
    state = await api('/api/state');
    $('status').textContent = state.session + ' · ' + state.cwd + ' · ' + state.channels.length + ' channels · next brief: ' + (state.nextBrief || 'disabled');
    $('channels').innerHTML = state.channels.length ? state.channels.map((c) =>
      '<div class="card"><div class="title">#' + esc(c.name) + '</div><div class="meta">' + esc(c.createdBy) + ' · ' + esc(c.sessionId) + '</div></div>'
    ).join('') : '<div class="muted">samo #main</div>';
    $('briefs').innerHTML = state.briefs.length ? state.briefs.map((b) =>
      '<div class="card brief" data-file="' + esc(b.file) + '"><div class="title">' + esc(b.title) + '</div><div class="meta">' + esc(b.created) + '</div></div>'
    ).join('') : '<div class="muted">nema briefova</div>';
    document.querySelectorAll('.brief').forEach((el) => el.onclick = () => openBrief(el.dataset.file));
    $('approvals').innerHTML = state.approvals.length ? state.approvals.map((a) =>
      '<div class="card"><div class="title">' + esc(a.title) + ' <span class="pill ' + esc(a.status) + '">' + esc(a.status) + '</span></div>' +
      '<div class="meta">' + esc(a.type) + (a.command ? ' · ' + esc(a.command) : '') + (a.url ? ' · ' + esc(a.url) : '') + '</div>' +
      (a.reason ? '<div class="meta">' + esc(a.reason) + '</div>' : '') +
      '<div class="row" style="margin-top:8px"><button class="green" data-approve="' + esc(a.id) + '">Approve</button><button class="red" data-reject="' + esc(a.id) + '">Reject</button></div></div>'
    ).join('') : '<div class="muted">nema pending akcija</div>';
    document.querySelectorAll('[data-approve]').forEach((el) => el.onclick = () => act('approve', el.dataset.approve));
    document.querySelectorAll('[data-reject]').forEach((el) => el.onclick = () => act('reject', el.dataset.reject));
  } catch (error) {
    $('status').textContent = 'error: ' + error.message;
  }
}

async function openBrief(file) {
  const data = await api('/api/brief?file=' + encodeURIComponent(file));
  $('view').textContent = data.text;
}

async function act(kind, id) {
  try {
    await api('/api/' + kind, { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ id }) });
    await refresh();
  } catch (error) {
    alert(error.message);
  }
}

$('run-brief').onclick = async () => {
  $('run-status').textContent = 'running…';
  try {
    await api('/api/run-brief', { method: 'POST' });
    $('run-status').textContent = 'started';
  } catch (error) {
    $('run-status').textContent = error.message;
  }
};

refresh();
setInterval(refresh, 10000);
</script>
</body>
</html>`;
}

export async function startDashboard(options: DashboardOptions = {}): Promise<void> {
  const port = options.port ?? 8787;
  const configPath = options.config ?? CONFIG_FILE;
  const config = loadAgentConfig(configPath);
  const scheduler = new Scheduler(config, {
    onBrief: async () => {},
    onCheck: async () => {},
  });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page());
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/state") {
        const store = new ApprovalStore();
        const channels = new ChannelStore(
          workspaceFile(config.session, "channels.json"),
          config.session,
        );
        const nextBrief = scheduler.nextBriefAt();
        json(res, 200, {
          session: config.session,
          cwd: config.cwd,
          nextBrief: nextBrief ? nextBrief.toLocaleString() : null,
          channels: channels.list().map((channel) => ({
            id: channel.id,
            name: channel.name,
            sessionId: channel.sessionId,
            createdBy: channel.createdBy,
            createdAt: channel.createdAt,
          })),
          briefs: listBriefs(),
          approvals: store.list("pending"),
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/brief") {
        const file = url.searchParams.get("file") ?? "";
        const text = safeBrief(file);
        if (!text) {
          json(res, 404, { error: "brief not found" });
          return;
        }
        json(res, 200, { text });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/approve") {
        const body = (await readBody(req)) as { id?: string };
        if (!body.id) {
          json(res, 400, { error: "id required" });
          return;
        }
        const store = new ApprovalStore();
        const approval = await store.approve(body.id);
        json(res, 200, { approval, text: formatApproval(approval) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/reject") {
        const body = (await readBody(req)) as { id?: string };
        if (!body.id) {
          json(res, 400, { error: "id required" });
          return;
        }
        const store = new ApprovalStore();
        json(res, 200, { approval: store.reject(body.id) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/run-brief") {
        if (runningBrief) {
          json(res, 409, { error: "brief already running" });
          return;
        }
        runningBrief = true;
        void runBrief(config)
          .catch(() => undefined)
          .finally(() => {
            runningBrief = false;
          });
        json(res, 202, { started: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/run-check") {
        const body = (await readBody(req)) as { name?: string };
        const check = config.checks.find((item) => item.name === body.name);
        if (!check) {
          json(res, 404, { error: "check not found" });
          return;
        }
        void runCheck(config, check).catch(() => undefined);
        json(res, 202, { started: true });
        return;
      }

      json(res, 404, { error: "not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      json(res, 500, { error: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  const url = `http://127.0.0.1:${port}`;
  console.log(pc.green(`dashboard: ${url}`));
  console.log(pc.dim("Ctrl+C to stop."));

  if (options.open !== false && process.platform === "darwin") {
    await execFileAsync("open", [url]).catch(() => undefined);
  }

  const stop = () => {
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await new Promise<void>(() => {
    // Keep serving.
  });
}
