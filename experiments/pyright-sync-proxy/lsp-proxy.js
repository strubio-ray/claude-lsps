#!/usr/bin/env node
// PROTOTYPE — pyright stale-diagnostics sync proxy.
//
// Problem it solves: pyright is push-only (no diagnosticProvider), so it only
// re-analyzes an OPEN document when the client sends textDocument/didChange.
// Claude Code edits files on disk (Edit/Write tools) without sending didChange,
// so pyright keeps serving the diagnostics from the version it last saw — the
// "stale errors after a fix" symptom. A workspace/didChangeWatchedFiles event
// would NOT help: for an open document the server authoritatively uses the
// client's in-memory buffer, not disk. The only refresh lever is didChange.
//
// VALIDATED against real Claude Code v2.1.207 (see ../lsp-wiretap/FINDINGS.md):
// the client DOES send didChange+didSave for its own Edit-tool edits, but sends
// NOTHING for out-of-band disk changes (Bash sed/git/formatters/other
// sessions) — those are the stale window this proxy closes.
//
// What this proxy does: it sits between Claude Code and pyright, forwarding all
// traffic transparently (NO method-blocking, NO server→client auto-ack — pyright
// works direct today, so we preserve that exactly), and adds ONE behavior:
//   - it records every document the client opens (textDocument/didOpen),
//   - polls those files on disk, and
//   - when an open file's content diverges from the last known buffer content,
//     injects a synthetic textDocument/didChange (full-text) so pyright
//     re-analyzes and re-publishes.
//
// Version/buffer reconciliation (NOT back-off): the real client is a hybrid —
// it didChanges its own edits but never syncs out-of-band ones — so the proxy
// keeps tracking through client didChanges rather than deferring permanently.
// It mirrors the client's full-text didChange into its own text/version state
// (client remains authoritative for its own edits) and keeps watching disk.
// Injected versions continue from max(client version, injected version);
// pyright applies didChange content regardless of version ordering (verified
// empirically — regressed/repeated versions still re-publish), so a client
// version arriving "behind" an injected one is harmless.
//
// If a client ever sends an INCREMENTAL didChange (range-based), the proxy can
// no longer reconstruct the buffer and permanently disables disk-sync for that
// document (logged once). Claude Code sends full-text changes only.
//
// Usage: node lsp-proxy.js --config <path-to-proxy.json>
// proxy.json: { "server": ["pyright-langserver","--stdio"], "sync": { "pollMs": 300 } }
//
// Node stdlib only, per repo convention.

const { spawn } = require('node:child_process');
const { readFileSync, statSync } = require('node:fs');
const { resolve } = require('node:path');
const { fileURLToPath } = require('node:url');

// -- Config ------------------------------------------------------------------

const configIdx = process.argv.indexOf('--config');
if (configIdx === -1 || !process.argv[configIdx + 1]) {
  process.stderr.write('Usage: lsp-proxy --config <path-to-proxy.json>\n');
  process.exit(1);
}
const configPath = resolve(process.argv[configIdx + 1]);
let config;
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'));
} catch (err) {
  process.stderr.write(`[pyright-sync] Failed to read config: ${err.message}\n`);
  process.exit(1);
}
if (!Array.isArray(config.server) || config.server.length === 0) {
  process.stderr.write('[pyright-sync] Config "server" must be a non-empty array\n');
  process.exit(1);
}

const SERVER_CMD = config.server[0];
const SERVER_ARGS = config.server.slice(1);
const POLL_MS = Math.max(50, config.sync?.pollMs || 300);

// -- Framing -----------------------------------------------------------------

const HEADER_DELIM = Buffer.from('\r\n\r\n');
const CONTENT_LENGTH_RE = /^content-length:\s*(\d+)\s*$/im;

function writeMessage(stream, obj) {
  if (!stream?.writable) return;
  const buf = Buffer.from(JSON.stringify(obj));
  stream.write(`Content-Length: ${buf.length}\r\n\r\n`);
  stream.write(buf);
}

// -- Open-document tracking --------------------------------------------------

// uri -> { version, text, path, stat: {mtimeMs,size}|null, pending: bool,
//          unsyncable: bool }
// `text` mirrors the last known BUFFER content (didOpen text, then client
// full-text didChanges, then our injected texts). `unsyncable` is set when an
// incremental didChange makes the buffer unreconstructable.
const open = new Map();

function toPath(uri) {
  try {
    return uri.startsWith('file:') ? fileURLToPath(uri) : null;
  } catch {
    return null;
  }
}

function statOf(p) {
  try {
    const s = statSync(p);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

function sameStat(a, b) {
  return a && b && a.mtimeMs === b.mtimeMs && a.size === b.size;
}

// -- Spawn pyright; server→client is a transparent raw pipe ------------------

const child = spawn(SERVER_CMD, SERVER_ARGS, { stdio: ['pipe', 'pipe', 'inherit'] });
child.stdout.pipe(process.stdout);

child.on('error', (err) => {
  process.stderr.write(`[pyright-sync] child error: ${err.message}\n`);
  process.exit(1);
});
child.on('exit', (code) => {
  clearInterval(pollTimer);
  process.exit(code ?? 1);
});

// -- Client→server: observe didOpen/didChange/didClose, forward everything ---

let buffer = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drainClient();
});
process.stdin.on('end', () => {
  clearInterval(pollTimer);
  child.kill('SIGTERM');
});

function drainClient() {
  while (true) {
    const delimIdx = buffer.indexOf(HEADER_DELIM);
    if (delimIdx === -1) return;
    const header = buffer.subarray(0, delimIdx).toString('ascii');
    const match = CONTENT_LENGTH_RE.exec(header);
    if (!match) {
      // Unrecoverable header: forward what we have and reset (mirrors the
      // sibling proxies' fail-safe).
      child.stdin.write(buffer);
      buffer = Buffer.alloc(0);
      return;
    }
    const contentLength = parseInt(match[1], 10);
    const bodyStart = delimIdx + HEADER_DELIM.length;
    const messageEnd = bodyStart + contentLength;
    if (buffer.length < messageEnd) return;

    const rawMessage = buffer.subarray(0, messageEnd);
    const bodyBytes = buffer.subarray(bodyStart, messageEnd);
    buffer = buffer.subarray(messageEnd);

    let msg = null;
    try {
      msg = JSON.parse(bodyBytes.toString('utf8'));
    } catch {
      /* forward raw */
    }
    if (msg) observe(msg);

    // Always forward the client's original bytes unchanged.
    child.stdin.write(rawMessage);
  }
}

function observe(msg) {
  const td = msg.params?.textDocument;
  switch (msg.method) {
    case 'textDocument/didOpen': {
      if (!td?.uri) return;
      const p = toPath(td.uri);
      open.set(td.uri, {
        version: typeof td.version === 'number' ? td.version : 1,
        text: td.text != null ? td.text : '',
        path: p,
        stat: p ? statOf(p) : null,
        pending: false,
        unsyncable: false,
      });
      break;
    }
    case 'textDocument/didChange': {
      // Mirror the client's edit into our buffer model and keep watching disk.
      // (Claude Code didChanges its own Edit-tool writes but never syncs
      // out-of-band disk edits, so permanent deferral would reopen the stale
      // window on any document the client ever edited.)
      if (!td?.uri) return;
      const st = open.get(td.uri);
      if (!st) return;
      if (typeof td.version === 'number' && td.version > st.version) {
        st.version = td.version;
      }
      const changes = msg.params.contentChanges;
      if (!Array.isArray(changes)) return;
      for (const c of changes) {
        if (c && c.range === undefined && typeof c.text === 'string') {
          st.text = c.text; // full-document replacement
        } else if (!st.unsyncable) {
          // Incremental edit — buffer no longer reconstructable from taps.
          st.unsyncable = true;
          process.stderr.write(
            `[pyright-sync] incremental didChange for ${td.uri}; disk-sync disabled for it\n`,
          );
        }
      }
      break;
    }
    case 'textDocument/didClose': {
      if (td?.uri) open.delete(td.uri);
      break;
    }
    default:
      break;
  }
}

// -- Disk-sync poll: inject didChange when an open file changes on disk -------
//
// Two-tick stability gate: we only inject once a file's (mtime,size) has been
// steady across consecutive polls, so a mid-write partial read never reaches
// pyright. This adds up to one POLL_MS of latency to the refresh.

const pollTimer = setInterval(pollOpenFiles, POLL_MS);
if (pollTimer.unref) pollTimer.unref();

function pollOpenFiles() {
  for (const [uri, st] of open) {
    if (st.unsyncable || !st.path) continue;
    const cur = statOf(st.path);
    if (!cur) {
      st.pending = false;
      continue;
    }

    if (!sameStat(cur, st.stat)) {
      // Disk changed since last poll — record and wait one tick for it to settle.
      st.stat = cur;
      st.pending = true;
      continue;
    }
    if (!st.pending) continue;

    // Stable for a full tick — safe to read and (maybe) inject.
    st.pending = false;
    let text;
    try {
      text = readFileSync(st.path, 'utf8');
    } catch {
      continue;
    }
    if (text === st.text) continue; // content-identical (e.g. touch) — no-op

    st.version += 1;
    st.text = text;
    writeMessage(child.stdin, {
      jsonrpc: '2.0',
      method: 'textDocument/didChange',
      params: {
        textDocument: { uri, version: st.version },
        contentChanges: [{ text }],
      },
    });
    process.stderr.write(`[pyright-sync] injected didChange ${uri} v${st.version}\n`);
  }
}

// -- Signals -----------------------------------------------------------------

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    clearInterval(pollTimer);
    child.kill(sig);
  });
}
