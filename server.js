#!/usr/bin/env node
// ccusage-dashboard: live local web dashboard for ccusage.
// Usage: ccusage-dashboard [run|start|stop|restart|status]
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

const PORT = Number(process.env.PORT) || 3939;
const HOST = process.env.HOST || '127.0.0.1'; // usage data is private: localhost only by default
const INTERVAL = (Number(process.env.INTERVAL) || 15) * 1000;
const URL_ = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
const STATE_DIR = path.join(os.homedir(), '.ccusage-dashboard');
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
function serve() {
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
    console.log(`ccusage dashboard → ${URL_}  (refresh every ${INTERVAL / 1000}s)`);
    refresh();
    setInterval(refresh, INTERVAL);
  });
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
  if (running) return console.log(`Already running → ${running.url}  (pid ${running.pid})`);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const log = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [__filename, 'run'], { detached: true, stdio: ['ignore', log, log], env: process.env, windowsHide: true });
  child.unref();
  fs.writeFileSync(PID_FILE, JSON.stringify({ pid: child.pid, url: URL_ }));
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (!readPid()) break;
    if (await fetch(URL_ + '/api/usage').then((r) => r.ok, () => false)) {
      return console.log(`ccusage dashboard running in the background → ${URL_}\nStop it with: ccusage-dashboard stop`);
    }
  }
  console.error(`Failed to start. See ${LOG_FILE}`);
  process.exitCode = 1;
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

const HELP = `ccusage-dashboard — live local dashboard for ccusage

Usage:
  ccusage-dashboard            run in the foreground (Ctrl+C to quit)
  ccusage-dashboard start      run in the background
  ccusage-dashboard stop       stop the background server
  ccusage-dashboard restart    restart the background server
  ccusage-dashboard status     show whether it is running

Env: PORT (3939), HOST (127.0.0.1), INTERVAL seconds (15), CCUSAGE_BIN`;

const cmd = process.argv[2] || 'run';
({
  run: serve,
  start,
  stop,
  status,
  restart: async () => { stop(); await new Promise((r) => setTimeout(r, 500)); await start(); },
  help: () => console.log(HELP), '--help': () => console.log(HELP), '-h': () => console.log(HELP),
}[cmd] || (() => { console.error(`Unknown command: ${cmd}\n\n${HELP}`); process.exitCode = 1; }))();
