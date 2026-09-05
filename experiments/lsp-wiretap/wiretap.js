#!/usr/bin/env node
// Transparent LSP wire-tap.
//
// Sits between an LSP client and a real server, forwards every byte unchanged
// in both directions, and appends one JSONL record per message to a log file.
// Unlike the sync-proxy prototype, this NEVER mutates traffic — its whole point
// is to observe what a real client (Claude Code) actually sends, so the
// pyright-sync-proxy premise ("Claude Code never sends didChange after Edit
// tool edits") can be validated against reality instead of inferred.
//
// Usage: node wiretap.js --log <file.jsonl> -- <server-cmd> [args...]
//        (or set LSP_WIRETAP_LOG instead of --log)
//
// Logged per message: timestamp, direction (c2s/s2c), JSON-RPC kind
// (request/response/notification), method, id, and — for document-lifecycle
// methods — the uri, version, and text byte-length. Document TEXT is never
// logged (size only), so the log is safe to share.
//
// Node stdlib only, per repo convention.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const { resolve } = require('node:path');

// -- CLI ----------------------------------------------------------------------

const argv = process.argv.slice(2);
const sepIdx = argv.indexOf('--');
if (sepIdx === -1 || sepIdx === argv.length - 1) {
  process.stderr.write('Usage: wiretap.js [--log <file.jsonl>] -- <server-cmd> [args...]\n');
  process.exit(1);
}
const opts = argv.slice(0, sepIdx);
const serverCmd = argv[sepIdx + 1];
const serverArgs = argv.slice(sepIdx + 2);

let logPath = process.env.LSP_WIRETAP_LOG || null;
const logIdx = opts.indexOf('--log');
if (logIdx !== -1 && opts[logIdx + 1]) logPath = opts[logIdx + 1];
if (!logPath) {
  process.stderr.write('wiretap: no --log and no LSP_WIRETAP_LOG; refusing to run blind\n');
  process.exit(1);
}
logPath = resolve(logPath);

// Append-mode stream: several sessions can share one log file; records carry
// pid so they can be separated afterwards.
const logStream = fs.createWriteStream(logPath, { flags: 'a' });
function logRecord(rec) {
  logStream.write(`${JSON.stringify({ t: Date.now(), pid: process.pid, ...rec })}\n`);
}

// -- Framing ------------------------------------------------------------------

const HEADER_DELIM = Buffer.from('\r\n\r\n');
const CONTENT_LENGTH_RE = /^content-length:\s*(\d+)\s*$/im;

// Incremental frame scanner; calls onMessage(parsedOrNull) for each complete
// frame. Forwarding happens on the raw stream separately — the tap never
// rewrites bytes, so a parse failure only means a null message record.
function makeScanner(onMessage) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const di = buf.indexOf(HEADER_DELIM);
      if (di === -1) return;
      const header = buf.subarray(0, di).toString('ascii');
      const m = CONTENT_LENGTH_RE.exec(header);
      if (!m) {
        // Can't find the body boundary — drop the tap's buffer (forwarding is
        // unaffected) and log the desync once.
        onMessage(null, buf.length);
        buf = Buffer.alloc(0);
        return;
      }
      const end = di + HEADER_DELIM.length + parseInt(m[1], 10);
      if (buf.length < end) return;
      const body = buf.subarray(di + HEADER_DELIM.length, end);
      buf = buf.subarray(end);
      let msg = null;
      try {
        msg = JSON.parse(body.toString('utf8'));
      } catch {}
      onMessage(msg, body.length);
    }
  };
}

function describe(msg, bodyLen) {
  if (!msg) return { kind: 'unparseable', bodyLen };
  const rec = {};
  if (msg.method !== undefined && msg.id !== undefined) rec.kind = 'request';
  else if (msg.method !== undefined) rec.kind = 'notification';
  else rec.kind = 'response';
  if (msg.method) rec.method = msg.method;
  if (msg.id !== undefined) rec.id = msg.id;
  if (msg.error) rec.error = { code: msg.error.code, message: msg.error.message };

  const p = msg.params;
  const td = p?.textDocument;
  if (td) {
    if (td.uri) rec.uri = td.uri;
    if (td.version !== undefined) rec.version = td.version;
    if (typeof td.text === 'string') rec.textLen = Buffer.byteLength(td.text);
  }
  if (msg.method === 'textDocument/didChange' && p && Array.isArray(p.contentChanges)) {
    rec.changes = p.contentChanges.map((c) => ({
      full: c.range === undefined,
      textLen: typeof c.text === 'string' ? Buffer.byteLength(c.text) : 0,
    }));
  }
  if (msg.method === 'textDocument/publishDiagnostics' && p) {
    rec.uri = p.uri;
    rec.diagCount = Array.isArray(p.diagnostics) ? p.diagnostics.length : 0;
    if (p.version !== undefined) rec.version = p.version;
  }
  if (msg.method === 'workspace/didChangeWatchedFiles' && p && Array.isArray(p.changes)) {
    rec.watched = p.changes.map((c) => ({ uri: c.uri, type: c.type }));
  }
  return rec;
}

// -- Spawn + bidirectional raw forwarding with taps ----------------------------

const child = spawn(serverCmd, serverArgs, { stdio: ['pipe', 'pipe', 'inherit'] });

logRecord({ dir: 'meta', event: 'start', server: [serverCmd, ...serverArgs] });

const tapC2S = makeScanner((msg, len) => logRecord({ dir: 'c2s', ...describe(msg, len) }));
const tapS2C = makeScanner((msg, len) => logRecord({ dir: 's2c', ...describe(msg, len) }));

process.stdin.on('data', (chunk) => {
  tapC2S(chunk);
  child.stdin.write(chunk);
});
child.stdout.on('data', (chunk) => {
  tapS2C(chunk);
  process.stdout.write(chunk);
});

// Expected-shutdown tracking (mirrors the production proxy): stdin EOF
// SIGTERMs the child, which usually dies BY the signal (code null) — that
// normal path must not read as exit status 1.
let shuttingDown = false;

process.stdin.on('end', () => {
  shuttingDown = true;
  child.kill('SIGTERM');
});
child.stdin.on('error', () => {});
child.on('error', (err) => {
  logRecord({ dir: 'meta', event: 'child-error', message: err.message });
  process.exit(1);
});
child.on('exit', (code, signal) => {
  logRecord({ dir: 'meta', event: 'exit', code, signal });
  logStream.end(() => process.exit(code ?? (shuttingDown ? 0 : 1)));
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    shuttingDown = true;
    child.kill(sig);
  });
}
