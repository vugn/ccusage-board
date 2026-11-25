#!/usr/bin/env node
// ccusage-board: live local web dashboard for ccusage.
// Usage: ccusage-board [run|start|stop|restart|status]
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

const PORT = Number(process.env.PORT) || 3939;
const HOST = process.env.HOST || '127.0.0.1'; // usage data is private: localhost only by default
const INTERVAL = (Number(process.env.INTERVAL) || 15) * 1000;
const URL_ = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
const STATE_DIR = path.join(os.homedir(), '.ccusage-board');
const PID_FILE = path.join(STATE_DIR, 'server.pid');
const LOG_FILE = path.join(STATE_DIR, 'server.log');

// Prefer the bundled ccusage; CCUSAGE_BIN overrides it.
function ccusageCommand() {
  if (process.env.CCUSAGE_BIN) return process.env.CCUSAGE_BIN.split(' ');
  try {
    const pj = require.resolve('ccusage/package.json');
    const { bin } = require(pj);
    return [process.execPath, path.join(path.dirname(pj), typeof bin === 'string' ? bin : bin.ccusage)];
  } catch {
    return ['npx', '-y', 'ccusage@latest'];
  }
}
const [BIN, ...BIN_ARGS] = ccusageCommand();

function ccusage(args) {
  return new Promise((resolve, reject) => {
    execFile(BIN, [...BIN_ARGS, ...args, '--json'],
      { maxBuffer: 256 * 1024 * 1024, shell: process.platform === 'win32' && BIN === 'npx' },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr.trim() || err.message));
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error('ccusage returned invalid JSON')); }
      });
  });
}

// ---------- server ----------
function serve(open = false) {
  let state = { updatedAt: null, error: 'loading…' };
  let stateJson = JSON.stringify(state);
  const clients = new Set();
  let running = false;

  async function refresh() {
    if (running) return;
    running = true;
    try {
      const [daily, blocks] = await Promise.all([
        ccusage(['daily', '--by-agent']),
        ccusage(['blocks', '--active']).catch(() => ({ blocks: [] })), // only some agents have billing blocks
      ]);
      state = { daily: daily.daily, totals: daily.totals, block: blocks.blocks?.[0] || null, updatedAt: new Date().toISOString(), error: null };
    } catch (e) {
      state = { ...state, updatedAt: new Date().toISOString(), error: e.message };
      console.error(`[${new Date().toISOString()}] ccusage failed:`, e.message);
    } finally {
      running = false;
    }
    stateJson = JSON.stringify(state);
    for (const res of clients) res.write(`data: ${stateJson}\n\n`);
  }

  const INDEX = path.join(__dirname, 'public', 'index.html');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      fs.createReadStream(INDEX).pipe(res);
    } else if (url.pathname === '/api/usage') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(stateJson);
    } else if (url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`retry: 3000\ndata: ${stateJson}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
    } else if (url.pathname === '/api/refresh' && req.method === 'POST') {
      refresh().then(() => { res.writeHead(204); res.end(); });
    } else {
      res.writeHead(404); res.end('not found');
    }
  });
  server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Set PORT=<number> to use another one.` : e.message);
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    console.log(`ccusage-board → ${URL_}  (refresh every ${INTERVAL / 1000}s)`);
    refresh();
    setInterval(refresh, INTERVAL);
    if (open) openBrowser(URL_);
  });
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => console.log(`Open ${url} in your browser.`)).unref();
}

// ---------- background daemon ----------
function readPid() {
  try {
    const info = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
    process.kill(info.pid, 0); // throws if the process is gone
    return info;
  } catch {
    return null;
  }
}

async function start() {
  const running = readPid();
  if (running) { console.log(`Already running → ${running.url}  (pid ${running.pid})`); return true; }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const log = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [__filename, 'run'], { detached: true, stdio: ['ignore', log, log], env: process.env, windowsHide: true });
  child.unref();
  fs.writeFileSync(PID_FILE, JSON.stringify({ pid: child.pid, url: URL_ }));
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (!readPid()) break;
    if (await fetch(URL_ + '/api/usage').then((r) => r.ok, () => false)) {
      console.log(`ccusage-board running in the background → ${URL_}\nIt keeps running after you close this terminal. Stop it with: ccusage-board stop`);
      return true;
    }
  }
  console.error(`Failed to start. See ${LOG_FILE}`);
  process.exitCode = 1;
  return false;
}

// Interactive launcher shown when run with no command in a terminal.
async function menu() {
  const running = readPid();
  if (running) {
    console.log(`ccusage-board is already running in the background → ${running.url}`);
    return openBrowser(running.url);
  }
  const rl = require('node:readline/promises').createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => { rl.close(); process.exit(130); });
  console.log(`
  \x1b[1m\x1b[33mcc\x1b[0m\x1b[1musage-board\x1b[0m  live dashboard for your AI coding agent usage

  1) Open in browser     run here and open ${URL_}  (Ctrl+C to stop)
  2) Run in background   keep running after you close this terminal, then open the browser
  3) Terminal only       run here without opening a browser
`);
  let choice;
  while (!['1', '2', '3'].includes(choice)) choice = (await rl.question('  Choose 1-3 [1]: ')).trim() || '1';
  rl.close();
  console.log();
  if (choice === '2') { if (await start()) openBrowser(URL_); }
  else serve(choice === '1');
}

function openCmd() {
  const running = readPid();
  if (!running) { console.log('Not running. Start it with: ccusage-board start'); process.exitCode = 1; return; }
  openBrowser(running.url);
}

function stop() {
  const running = readPid();
  if (!running) return console.log('Not running.');
  process.kill(running.pid);
  fs.rmSync(PID_FILE, { force: true });
  console.log(`Stopped (pid ${running.pid}).`);
}

function status() {
  const running = readPid();
  console.log(running ? `Running → ${running.url}  (pid ${running.pid}, log ${LOG_FILE})` : 'Not running.');
}

const HELP = `ccusage-board — live local dashboard for ccusage

Usage:
  ccusage-board            choose: open in browser, run in background, or terminal only
  ccusage-board run        run in the foreground without asking (Ctrl+C to quit)
  ccusage-board start      run in the background (keeps running until you stop it)
  ccusage-board open       open the running dashboard in your browser
  ccusage-board stop       stop the background server
  ccusage-board restart    restart the background server
  ccusage-board status     show whether it is running

Env: PORT (3939), HOST (127.0.0.1), INTERVAL seconds (15), CCUSAGE_BIN`;

const cmd = process.argv[2] || (process.stdin.isTTY && process.stdout.isTTY ? 'menu' : 'run');
({
  menu,
  run: () => serve(),
  open: openCmd,
  start,
  stop,
  status,
  restart: async () => { stop(); await new Promise((r) => setTimeout(r, 500)); await start(); },
  help: () => console.log(HELP), '--help': () => console.log(HELP), '-h': () => console.log(HELP),
}[cmd] || (() => { console.error(`Unknown command: ${cmd}\n\n${HELP}`); process.exitCode = 1; }))();
