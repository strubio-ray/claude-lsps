#!/usr/bin/env node
// driver.mjs — launch an LSP proxy (any plugin copy; regal-lsp by default) and
// drive it with real JSON-RPC over stdio, then assert its wire behavior.
//
// The proxies are the only live, protocol-speaking code in this repo. On a
// clean machine the real language server (regal) is usually absent, so by default this driver points the proxy at the
// bundled stub server (tests/helpers/stub-server.js) — zero external installs.
//
//   node driver.mjs                      # drive regal proxy against the stub
//   node driver.mjs --plugin regal-lsp --live
//                                        # use the REAL server from proxy.json
//                                        # (must be installed & on PATH)
//
// Exit code 0 = every assertion passed. Non-zero = something is wrong.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..'); // .claude/skills/run-lsp-proxy -> repo root
const STUB = join(REPO, 'tests', 'helpers', 'stub-server.js');

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
function opt(name, def) {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : def;
}
const PLUGIN = opt('--plugin', 'regal-lsp');
const LIVE = argv.includes('--live');
const PLUGIN_DIR = join(REPO, PLUGIN);
const PROXY = join(PLUGIN_DIR, 'lsp-proxy.js');

// ---------------------------------------------------------------------------
// LSP framing
// ---------------------------------------------------------------------------
const DELIM = Buffer.from('\r\n\r\n');
const CL_RE = /^content-length:\s*(\d+)\s*$/im;
function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj));
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}
// Streaming parser: feed bytes, get back complete JSON messages.
function makeParser(onMessage) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const di = buf.indexOf(DELIM);
      if (di === -1) return;
      const m = CL_RE.exec(buf.subarray(0, di).toString('ascii'));
      if (!m) {
        buf = Buffer.alloc(0);
        return;
      }
      const start = di + DELIM.length;
      const end = start + parseInt(m[1], 10);
      if (buf.length < end) return;
      const body = buf.subarray(start, end);
      buf = buf.subarray(end);
      try {
        onMessage(JSON.parse(body.toString('utf8')));
      } catch {
        /* ignore */
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Build a warmup root (only matters for regal): a dir with .rego files.
// ---------------------------------------------------------------------------
const workRoot = mkdtempSync(join(tmpdir(), 'lsp-proxy-drive-'));
writeFileSync(join(workRoot, 'policy.rego'), 'package a\nallow = true\n');
writeFileSync(join(workRoot, 'extra.rego'), 'package b\ndeny = false\n');
writeFileSync(join(workRoot, 'notrego.txt'), 'ignore me\n');
const rootUri = pathToFileURL(workRoot).href;

// ---------------------------------------------------------------------------
// Effective proxy config: reuse the plugin's real blocked/warmup lists, but
// (unless --live) swap the server for the bundled stub.
// ---------------------------------------------------------------------------
const realConfig = JSON.parse(readFileSync(join(PLUGIN_DIR, 'proxy.json'), 'utf8'));
const stubLog = mkdtempSync(join(tmpdir(), 'lsp-proxy-stublog-'));
const cfg = { blocked: realConfig.blocked, warmup: realConfig.warmup };
if (LIVE) {
  cfg.server = realConfig.server;
} else {
  cfg.server = ['node', STUB];
}
const cfgPath = join(stubLog, 'effective-proxy.json');
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

// The stub is configured entirely by env vars (see stub-server.js header):
//  - AUTO_INIT so `initialize` gets a real capabilities response (needed to
//    trigger regal warmup, which waits for result.capabilities)
//  - HOVER_RESULT so a forwarded, non-blocked method round-trips
//  - EMIT a server-initiated workspace/configuration request on startup, to
//    prove the proxy auto-acks it (client must never see it)
//  - LOG_DIR so we can inspect exactly what bytes reached the server
const stubEnv = LIVE
  ? {}
  : {
      STUB_AUTO_INIT: '1',
      STUB_HOVER_RESULT: '1',
      STUB_LOG_DIR: stubLog,
      STUB_EMIT: JSON.stringify([
        { jsonrpc: '2.0', id: 9001, method: 'workspace/configuration', params: { items: [] } },
      ]),
    };

// ---------------------------------------------------------------------------
// Launch the proxy and drive it.
// ---------------------------------------------------------------------------
console.log(`▶ plugin      : ${PLUGIN}`);
console.log(`▶ proxy       : ${PROXY}`);
console.log(`▶ server      : ${LIVE ? `${cfg.server.join(' ')}  (LIVE)` : 'stub-server.js'}`);
console.log(`▶ blocked     : ${cfg.blocked.join(', ')}`);
console.log(`▶ warmup      : ${cfg.warmup ? cfg.warmup.extensions.join(',') : '(none)'}`);
console.log(`▶ workRoot    : ${workRoot}`);
console.log('');

const proxy = spawn('node', [PROXY, '--config', cfgPath], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, ...stubEnv },
});

const fromServerToClient = []; // messages the proxy forwarded to us (the client)
const feed = makeParser((msg) => {
  fromServerToClient.push(msg);
  const tag = msg.id !== undefined ? `id=${msg.id}` : 'notif';
  console.log(
    `  ← proxy→client  ${tag} ${msg.method || (msg.result !== undefined ? 'result' : 'error')}`,
  );
});
proxy.stdout.on('data', feed);

function send(obj) {
  const label = obj.id !== undefined ? `id=${obj.id} ${obj.method}` : obj.method;
  console.log(`  → client→proxy  ${label}`);
  proxy.stdin.write(frame(obj));
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function waitForId(id, timeout = 4000) {
  return new Promise((resolveP, rejectP) => {
    const deadline = Date.now() + timeout;
    const poll = setInterval(() => {
      const hit = fromServerToClient.find((m) => m.id === id);
      if (hit) {
        clearInterval(poll);
        resolveP(hit);
      } else if (Date.now() > deadline) {
        clearInterval(poll);
        rejectP(new Error(`timeout waiting for id=${id}`));
      }
    }, 20);
  });
}

// Blocked method declared in regal-lsp/proxy.json:
const BLOCKED_METHOD = 'textDocument/references';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`);
}

async function main() {
  console.log('── conversation ──');
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { processId: process.pid, rootUri, capabilities: {} },
  });
  const initResp = await waitForId(1);
  check('initialize forwarded & answered', !!initResp.result?.capabilities, 'got capabilities');

  send({ jsonrpc: '2.0', method: 'initialized', params: {} });
  await wait(300); // let regal warmup fire (setImmediate → didOpen burst)

  // Blocked request → proxy must synthesize {result:null} itself; server must NOT see it.
  send({
    jsonrpc: '2.0',
    id: 2,
    method: BLOCKED_METHOD,
    params: {
      textDocument: { uri: `${rootUri}/x` },
      position: { line: 0, character: 0 },
      context: { includeDeclaration: true },
    },
  });
  const blockedResp = await waitForId(2);
  check(
    `blocked ${BLOCKED_METHOD} → null result`,
    blockedResp.result === null,
    JSON.stringify(blockedResp.result),
  );

  // Non-blocked request → forwarded, real (stub) response round-trips back.
  send({
    jsonrpc: '2.0',
    id: 3,
    method: 'textDocument/hover',
    params: { textDocument: { uri: `${rootUri}/x` }, position: { line: 0, character: 0 } },
  });
  if (!LIVE) {
    const hoverResp = await waitForId(3);
    check(
      'non-blocked hover forwarded & answered',
      hoverResp.result && hoverResp.result.contents === 'hover-result',
      JSON.stringify(hoverResp.result),
    );
  }

  // Give async logging a beat, then inspect what the SERVER actually received.
  await wait(200);
  if (!LIVE) {
    let recv = [];
    try {
      recv = readFileSync(join(stubLog, 'recv.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      /* no log */
    }

    const serverSawBlocked = recv.some((m) => m.method === BLOCKED_METHOD);
    check(
      `server never saw ${BLOCKED_METHOD}`,
      !serverSawBlocked,
      serverSawBlocked ? 'LEAKED to server' : 'intercepted at proxy',
    );

    const serverGotAck = recv.some(
      (m) => m.id === 9001 && m.result === null && m.method === undefined,
    );
    check(
      'server-initiated workspace/configuration auto-acked',
      serverGotAck,
      serverGotAck ? 'ack reached server' : 'no ack seen',
    );

    const clientSawConfig = fromServerToClient.some((m) => m.method === 'workspace/configuration');
    check(
      'client shielded from workspace/configuration',
      !clientSawConfig,
      clientSawConfig ? 'leaked to client' : 'never forwarded',
    );

    if (cfg.warmup) {
      const opened = recv
        .filter((m) => m.method === 'textDocument/didOpen')
        .map((m) => m.params.textDocument.uri);
      const regoOpened = opened.filter((u) => u.endsWith('.rego'));
      check(
        'warmup opened all .rego files',
        regoOpened.length === 2,
        `${regoOpened.length} didOpen (.rego)`,
      );
      const openedTxt = opened.some((u) => u.endsWith('.txt'));
      check(
        'warmup skipped non-.rego files',
        !openedTxt,
        openedTxt ? 'opened a .txt' : 'extension filter held',
      );
    }
  }

  // Clean shutdown: closing stdin makes the proxy SIGTERM its child and exit.
  console.log('── shutdown ──');
  proxy.stdin.end();
  await wait(150);
  if (!proxy.killed) proxy.kill('SIGTERM');
}

const HARD_TIMEOUT = setTimeout(() => {
  console.error('\n✗ hard timeout — proxy did not complete the conversation');
  proxy.kill('SIGKILL');
  process.exit(2);
}, 15000);

main()
  .then(() => {
    clearTimeout(HARD_TIMEOUT);
    const failed = results.filter((r) => !r.ok);
    console.log('');
    console.log(
      `${failed.length === 0 ? '✅ PASS' : '❌ FAIL'} — ${results.length - failed.length}/${results.length} checks`,
    );
    process.exit(failed.length === 0 ? 0 : 1);
  })
  .catch((err) => {
    clearTimeout(HARD_TIMEOUT);
    console.error(`\n✗ driver error: ${err.message}`);
    try {
      proxy.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    process.exit(2);
  });
