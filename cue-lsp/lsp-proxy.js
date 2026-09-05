#!/usr/bin/env node
// Unified LSP proxy for Claude Code plugins — the standard wrapper for every
// plugin in this marketplace. All six plugin directories carry a byte-identical
// copy of this file (enforced by tests/cases/02-consistency.sh); behavior is
// driven entirely by each plugin's proxy.json.
//
// Responsibilities (each config-gated where noted):
//
//   1. BLOCKED METHODS ("blocked"): intercept client→server requests for
//      methods the server answers with JSON-RPC -32601, which puts Claude
//      Code's LSP client into an unrecoverable broken state. The proxy
//      synthesizes {result: null} instead and drops blocked notifications.
//
//   2. AUTO-ACK: answer server→client requests Claude Code's client can't
//      handle (client/registerCapability, client/unregisterCapability,
//      workspace/configuration, window/workDoneProgress/create) so the server
//      doesn't deadlock. workspace/configuration gets the spec-correct
//      per-item null array (params.items.length entries), not a bare null.
//
//   3. WARMUP ("warmup"): after the client's `initialized`, walk rootUri for
//      matching files and send synthetic textDocument/didOpen so servers that
//      defer indexing until first-open (Regal) start immediately.
//
//   4. DISK-SYNC ("sync", default ON): Claude Code sends didChange+didSave for
//      its own Edit-tool writes but NOTHING for out-of-band disk edits (Bash
//      sed/git/formatters/other sessions) — validated by wire-tapping real
//      sessions; see experiments/lsp-wiretap/FINDINGS.md. Push-only servers
//      then serve stale diagnostics. The proxy tracks open documents (client
//      didOpens AND warmup opens), polls them on disk with a one-tick
//      stability gate, and injects a synthetic full-text didChange + didSave
//      when disk content diverges from the last known buffer content.
//
//      Reconciliation, not back-off: client didChanges are mirrored into the
//      proxy's buffer/version state (the client stays authoritative for its
//      own edits; a disk write matching the buffer is a no-op) and injected
//      versions continue from max(client, injected)+1. An INCREMENTAL
//      (range-based) client didChange makes the buffer unreconstructable —
//      disk-sync is disabled for that document (logged once).
//
//      Version rebasing: after an injection, the client's own version counter
//      lags the server's; a forwarded client didChange whose version doesn't
//      exceed the tracked one is rewritten to tracked+1 so servers that
//      enforce monotonically increasing versions never drop a client edit.
//
//      Deletion/reappearance: a tracked file that vanishes (rm, git checkout)
//      gets a synthetic didClose after the same two-tick gate — the server
//      drops the buffer and clears its diagnostics. The entry stays tracked:
//      if the file reappears it is reopened with disk content, and a client
//      edit on a proxy-closed document is converted into a reopen.
//
// Usage: node lsp-proxy.js --config <path-to-proxy.json>
//
// proxy.json format:
//   {
//     "server": ["command", "arg1", ...],
//     "blocked": ["method/name", ...],
//     "warmup": { "extensions": [".rego"], "exclude": ["node_modules", ...] },
//     "sync": { "pollMs": 300 }          // or false to disable disk-sync
//   }
//
// Node stdlib only, per repo convention.

const { spawn } = require('node:child_process');
const { readFileSync, readdirSync, statSync } = require('node:fs');
const { resolve, join, extname } = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');

// ---------------------------------------------------------------------------
// Load configuration
// ---------------------------------------------------------------------------

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
  process.stderr.write(`[lsp-proxy] Failed to read config: ${err.message}\n`);
  process.exit(1);
}

if (!Array.isArray(config.server) || config.server.length === 0) {
  process.stderr.write('[lsp-proxy] Config "server" must be a non-empty array\n');
  process.exit(1);
}

const SERVER_CMD = config.server[0];
const SERVER_ARGS = config.server.slice(1);
const BLOCKED_METHODS = new Set(config.blocked || []);
const WARMUP = config.warmup || null;
const SYNC = config.sync === false ? null : { pollMs: Math.max(50, config.sync?.pollMs || 300) };
const LOG_PREFIX = `[lsp-proxy:${SERVER_CMD}]`;

// ---------------------------------------------------------------------------
// LSP message framing helpers
// ---------------------------------------------------------------------------

const HEADER_DELIM = Buffer.from('\r\n\r\n');
const CONTENT_LENGTH_RE = /^content-length:\s*(\d+)\s*$/im;

function writeMessage(stream, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  stream.write(`Content-Length: ${buf.length}\r\n\r\n`);
  stream.write(buf);
}

// ---------------------------------------------------------------------------
// Spawn the real language server
// ---------------------------------------------------------------------------

const child = spawn(SERVER_CMD, SERVER_ARGS, {
  stdio: ['pipe', 'pipe', 'inherit'],
});

// Expected-shutdown tracking: stdin EOF and forwarded signals SIGTERM the
// child, which then usually dies BY the signal (exit code null). Without this
// flag the normal shutdown path would be reported as exit status 1.
let shuttingDown = false;

// ---------------------------------------------------------------------------
// Disk-sync: open-document tracking
// ---------------------------------------------------------------------------

// uri -> { version, text, path, stat: {mtimeMs,size}|null, pending: bool,
//          unsyncable: bool }
// `text` mirrors the last known BUFFER content (didOpen text, client full-text
// didChanges, warmup opens, injected texts).
const openDocs = new Map();

function toPath(uri) {
  try {
    return uri?.startsWith('file:') ? fileURLToPath(uri) : null;
  } catch {
    return null;
  }
}

// The change-detection tuple. ctimeMs catches rewrites that restore mtime
// (ctime cannot be set from userspace); ino catches atomic write-then-rename
// replaces that keep size and mtime. Residual blind spot: an in-place
// same-size rewrite landing within one timestamp quantum on a coarse-mtime
// filesystem — accepted; hashing every open file every tick would cost more
// than it buys.
function statOf(p) {
  try {
    const s = statSync(p);
    return { mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, size: s.size, ino: s.ino };
  } catch {
    return null;
  }
}

function sameStat(a, b) {
  return (
    a &&
    b &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.size === b.size &&
    a.ino === b.ino
  );
}

// Tracked even when disk-sync is off: openDocs doubles as the warmup dedup
// set (never send a synthetic didOpen for a document the client already
// opened — open-after-open is spec-undefined and Regal drops diagnostics on
// it). The poll loop itself only runs when SYNC is enabled.
function trackOpen(uri, text, version, languageId) {
  const p = toPath(uri);
  openDocs.set(uri, {
    version: typeof version === 'number' ? version : 1,
    text: text != null ? text : '',
    languageId: languageId || 'plaintext',
    path: p,
    stat: p ? statOf(p) : null,
    pending: false,
    missing: false,
    closed: false,
    unsyncable: false,
  });
}

// Reconcile a client didChange with proxy-side disk-sync state. Returns the
// frame to forward to the server: the original raw bytes, a version-rebased
// rewrite, or null when the change was converted into a reopen.
function reconcileClientChange(msg, rawMessage) {
  const td = msg.params.textDocument;
  const st = openDocs.get(td.uri);
  if (!st) return rawMessage;

  // Order-aware batch scan: contentChanges apply in sequence, so the buffer
  // is reconstructable iff the LAST effective change is a full-document
  // replacement — [incremental, fulltext] restores syncability, while
  // [fulltext, incremental] leaves the buffer unknown.
  const changes = msg.params.contentChanges;
  let knownText = null;
  let sawIncremental = false;
  if (Array.isArray(changes)) {
    for (const c of changes) {
      if (c && c.range === undefined && typeof c.text === 'string') {
        knownText = c.text; // full replacement: buffer known from here on
      } else {
        knownText = null; // incremental on top: buffer unknown again
        sawIncremental = true;
      }
    }
  }
  if (knownText !== null) {
    st.text = knownText;
    if (st.unsyncable) {
      st.unsyncable = false;
      process.stderr.write(
        `${LOG_PREFIX} disk-sync re-enabled for ${td.uri} (full-text didChange)\n`,
      );
    }
  } else if (sawIncremental && !st.unsyncable) {
    st.unsyncable = true;
    process.stderr.write(
      `${LOG_PREFIX} incremental didChange for ${td.uri}; disk-sync disabled for it\n`,
    );
  }

  // The proxy closed this document server-side (file deleted out-of-band) but
  // the client still edits it: reopen with the client's full content instead
  // of forwarding a didChange for a document the server considers closed.
  if (st.closed && knownText !== null) {
    st.closed = false;
    st.missing = false;
    st.pending = false;
    st.version = Math.max(typeof td.version === 'number' ? td.version : 0, st.version + 1);
    st.stat = st.path ? statOf(st.path) : null;
    writeMessage(
      child.stdin,
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'textDocument/didOpen',
        params: {
          textDocument: {
            uri: td.uri,
            languageId: st.languageId,
            version: st.version,
            text: knownText,
          },
        },
      }),
    );
    process.stderr.write(
      `${LOG_PREFIX} disk-sync: reopened ${td.uri} v${st.version} (client edit after deletion)\n`,
    );
    return null;
  }

  const clientV = typeof td.version === 'number' ? td.version : null;
  if (clientV !== null && clientV > st.version) {
    st.version = clientV;
    return rawMessage;
  }
  // The client's version counter lags the proxy's injected didChanges (it
  // can't know about them). Rebase the frame onto the next proxy version so
  // servers that enforce monotonically increasing versions never see the
  // client's next edit go backwards.
  st.version += 1;
  const rebased = {
    ...msg,
    params: { ...msg.params, textDocument: { ...td, version: st.version } },
  };
  const body = Buffer.from(JSON.stringify(rebased));
  process.stderr.write(
    `${LOG_PREFIX} disk-sync: rebased client didChange ${td.uri} v${clientV} -> v${st.version}\n`,
  );
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

// ---------------------------------------------------------------------------
// Disk-sync: poll loop
//
// Two-tick stability gate: only inject once a file's (mtime,size) has been
// steady across consecutive polls, so a mid-write partial read never reaches
// the server. Injects didChange (full text) + didSave, matching what Claude
// Code itself sends for Edit-tool writes.
// ---------------------------------------------------------------------------

function pollOpenDocs() {
  for (const [uri, st] of openDocs) {
    if (st.unsyncable || !st.path) continue;
    const cur = statOf(st.path);

    // Deletion: the file vanished out-of-band (rm, git checkout). Same
    // two-tick stability gate as edits, then inject didClose so the server
    // drops the buffer and clears its diagnostics. Keep tracking the entry:
    // if the file reappears (branch switched back), the reopen path below
    // brings it back.
    if (!cur) {
      if (st.closed) {
        st.pending = false;
        continue;
      }
      if (!st.missing) {
        st.missing = true;
        continue;
      } // first tick: arm
      st.missing = false;
      st.pending = false;
      st.closed = true;
      st.stat = null;
      writeMessage(
        child.stdin,
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'textDocument/didClose',
          params: { textDocument: { uri } },
        }),
      );
      process.stderr.write(`${LOG_PREFIX} disk-sync: closed ${uri} (file deleted)\n`);
      continue;
    }
    st.missing = false;

    if (!sameStat(cur, st.stat)) {
      // Disk changed since last poll — record and wait one tick to settle.
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

    // Reappearance of a proxy-closed document: reopen with disk content.
    if (st.closed) {
      st.closed = false;
      st.version += 1;
      st.text = text;
      writeMessage(
        child.stdin,
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'textDocument/didOpen',
          params: {
            textDocument: { uri, languageId: st.languageId, version: st.version, text },
          },
        }),
      );
      process.stderr.write(
        `${LOG_PREFIX} disk-sync: reopened ${uri} v${st.version} (file reappeared)\n`,
      );
      continue;
    }

    if (text === st.text) continue; // content-identical (touch, client's own write)

    st.version += 1;
    st.text = text;
    writeMessage(
      child.stdin,
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'textDocument/didChange',
        params: {
          textDocument: { uri, version: st.version },
          contentChanges: [{ text }],
        },
      }),
    );
    writeMessage(
      child.stdin,
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'textDocument/didSave',
        params: { textDocument: { uri } },
      }),
    );
    process.stderr.write(`${LOG_PREFIX} disk-sync: injected didChange ${uri} v${st.version}\n`);
  }
}

const pollTimer = SYNC ? setInterval(pollOpenDocs, SYNC.pollMs) : null;
if (pollTimer?.unref) pollTimer.unref();

// ---------------------------------------------------------------------------
// Warmup: file discovery
// ---------------------------------------------------------------------------

/**
 * Recursively find files matching the given extensions, skipping excluded dirs.
 * Uses a stack to avoid recursion depth issues on large trees.
 */
function findFiles(rootDir, extensions, excludeDirs) {
  const extSet = new Set(extensions);
  const excludeSet = new Set(excludeDirs);
  const results = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // Permission denied, symlink loop, etc. — skip silently.
      continue;
    }

    for (const entry of entries) {
      if (excludeSet.has(entry.name)) continue;

      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && extSet.has(extname(entry.name))) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

/**
 * Send textDocument/didOpen notifications to the server for each file.
 * Uses languageId derived from the file extension. Warmup-opened documents
 * enroll in disk-sync tracking like client-opened ones — a disk edit to a
 * warmup-opened file must refresh its diagnostics too.
 */
function warmupServer(rootDir) {
  if (!(WARMUP && Array.isArray(WARMUP.extensions)) || WARMUP.extensions.length === 0) {
    return;
  }

  const exclude = WARMUP.exclude || [];
  const files = findFiles(rootDir, WARMUP.extensions, exclude);

  if (files.length === 0) {
    process.stderr.write(`${LOG_PREFIX} warmup: no files found\n`);
    return;
  }

  process.stderr.write(`${LOG_PREFIX} warmup: opening ${files.length} file(s) for indexing\n`);

  // Map extensions to languageIds
  const extToLang = {
    '.rego': 'rego',
    '.py': 'python',
    '.ts': 'typescript',
    '.js': 'javascript',
    '.cue': 'cue',
    '.sh': 'shellscript',
    '.yml': 'yaml',
    '.yaml': 'yaml',
    '.swift': 'swift',
  };

  let version = 0;
  let sent = 0;
  for (const filePath of files) {
    const uri = pathToFileURL(filePath).href;
    // The client already opened this document (its didOpen raced ahead of the
    // deferred warmup) — a second open would be spec-undefined.
    if (openDocs.has(uri)) continue;

    let content;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch {
      continue; // Unreadable file — skip.
    }

    const ext = extname(filePath);
    const languageId = extToLang[ext] || ext.slice(1);

    const notification = JSON.stringify({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: {
        textDocument: {
          uri,
          languageId,
          version: version,
          text: content,
        },
      },
    });

    writeMessage(child.stdin, notification);
    trackOpen(uri, content, version, languageId);
    version++;
    sent++;
  }

  process.stderr.write(`${LOG_PREFIX} warmup: sent ${sent} didOpen notification(s)\n`);
}

// ---------------------------------------------------------------------------
// State tracking for warmup trigger
// ---------------------------------------------------------------------------

let rootUri = null;
let initializeResponseSeen = false;

// ---------------------------------------------------------------------------
// Server→client: parse messages, auto-respond to server-initiated requests
// ---------------------------------------------------------------------------

const SERVER_REQUESTS_AUTO_RESPOND = new Set([
  'client/registerCapability',
  'client/unregisterCapability',
  'workspace/configuration',
  'window/workDoneProgress/create',
]);

// workspace/configuration's spec-correct response is one entry per
// params.items element ("use defaults" = null each). A bare null here breaks
// servers that index into the array (pyright, vtsls).
function autoAckResult(msg) {
  if (msg.method === 'workspace/configuration') {
    const items = msg.params && Array.isArray(msg.params.items) ? msg.params.items : [];
    return items.map(() => null);
  }
  return null;
}

let serverBuffer = Buffer.alloc(0);

child.stdout.on('data', (chunk) => {
  serverBuffer = Buffer.concat([serverBuffer, chunk]);
  drainServerBuffer();
});

function drainServerBuffer() {
  while (true) {
    const delimIdx = serverBuffer.indexOf(HEADER_DELIM);
    if (delimIdx === -1) return;

    const header = serverBuffer.subarray(0, delimIdx).toString('ascii');
    const match = CONTENT_LENGTH_RE.exec(header);
    if (!match) {
      process.stdout.write(serverBuffer);
      serverBuffer = Buffer.alloc(0);
      return;
    }

    const contentLength = parseInt(match[1], 10);
    const bodyStart = delimIdx + HEADER_DELIM.length;
    const messageEnd = bodyStart + contentLength;

    if (serverBuffer.length < messageEnd) return;

    const rawMessage = serverBuffer.subarray(0, messageEnd);
    const bodyBytes = serverBuffer.subarray(bodyStart, messageEnd);
    serverBuffer = serverBuffer.subarray(messageEnd);

    let msg;
    try {
      msg = JSON.parse(bodyBytes.toString('utf8'));
    } catch {
      process.stdout.write(rawMessage);
      continue;
    }

    // Auto-respond to server-initiated requests the client can't handle.
    if (msg.id !== undefined && msg.method && SERVER_REQUESTS_AUTO_RESPOND.has(msg.method)) {
      const ack = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: autoAckResult(msg) });
      writeMessage(child.stdin, ack);
      continue;
    }

    // Detect the initialize response (has "capabilities" in result).
    // We use this + the subsequent "initialized" notification to trigger warmup.
    if (msg.result?.capabilities) {
      initializeResponseSeen = true;
    }

    // Forward everything else to the client.
    process.stdout.write(rawMessage);
  }
}

child.on('error', (err) => {
  process.stderr.write(`${LOG_PREFIX} child error: ${err.message}\n`);
  process.exit(1);
});

child.on('exit', (code) => {
  if (pollTimer) clearInterval(pollTimer);
  process.exit(code ?? (shuttingDown ? 0 : 1));
});

// ---------------------------------------------------------------------------
// Client→server: parse messages, intercept blocked methods, trigger warmup,
// observe document lifecycle for disk-sync
// ---------------------------------------------------------------------------

let buffer = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drainBuffer();
});

process.stdin.on('end', () => {
  shuttingDown = true;
  if (pollTimer) clearInterval(pollTimer);
  child.kill('SIGTERM');
});

function drainBuffer() {
  while (true) {
    const delimIdx = buffer.indexOf(HEADER_DELIM);
    if (delimIdx === -1) return;

    const header = buffer.subarray(0, delimIdx).toString('ascii');
    const match = CONTENT_LENGTH_RE.exec(header);
    if (!match) {
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

    let msg;
    try {
      msg = JSON.parse(bodyBytes.toString('utf8'));
    } catch {
      child.stdin.write(rawMessage);
      continue;
    }

    // Capture rootUri from the initialize request.
    if (msg.method === 'initialize' && msg.params) {
      rootUri = msg.params.rootUri || msg.params.rootPath || null;
      process.stderr.write(`${LOG_PREFIX} rootUri: ${rootUri}\n`);
    }

    // Observe document lifecycle for disk-sync bookkeeping. didChange may be
    // version-rebased or converted to a reopen (outFrame rewritten/nulled);
    // a client didClose for a document the proxy already closed server-side
    // (deleted file) is swallowed rather than closed twice.
    const td = msg.params?.textDocument;
    let outFrame = rawMessage;
    if (msg.method === 'textDocument/didOpen' && td && td.uri) {
      const st = openDocs.get(td.uri);
      if (st && !st.closed) {
        // The server already has this document open (warmup got there first,
        // or an earlier client open). Forwarding another didOpen is
        // spec-undefined — Regal drops the URI's diagnostics — so translate
        // the client's open into a full-text didChange: the client's buffer
        // becomes authoritative without a double open. (A proxy-CLOSED entry
        // falls through to the normal open below — the server really does
        // consider it closed.)
        st.text = td.text != null ? td.text : '';
        st.languageId = td.languageId || st.languageId;
        st.version = Math.max(typeof td.version === 'number' ? td.version : 0, st.version + 1);
        st.stat = st.path ? statOf(st.path) : null;
        st.pending = false;
        st.missing = false;
        st.unsyncable = false; // full text known again — buffer reconstructable
        writeMessage(
          child.stdin,
          JSON.stringify({
            jsonrpc: '2.0',
            method: 'textDocument/didChange',
            params: {
              textDocument: { uri: td.uri, version: st.version },
              contentChanges: [{ text: st.text }],
            },
          }),
        );
        process.stderr.write(
          `${LOG_PREFIX} translated client didOpen -> didChange for already-open ${td.uri} v${st.version}\n`,
        );
        outFrame = null;
      } else {
        trackOpen(td.uri, td.text, td.version, td.languageId);
      }
    } else if (msg.method === 'textDocument/didChange' && td && td.uri && SYNC) {
      outFrame = reconcileClientChange(msg, rawMessage);
    } else if (msg.method === 'textDocument/didClose' && td && td.uri) {
      const st = openDocs.get(td.uri);
      openDocs.delete(td.uri);
      if (st?.closed) outFrame = null;
    }

    // After "initialized" notification, trigger warmup.
    if (msg.method === 'initialized' && initializeResponseSeen && rootUri && WARMUP) {
      // Forward the initialized notification first.
      child.stdin.write(rawMessage);

      // Then trigger warmup asynchronously (setImmediate lets the event loop
      // flush the initialized notification to the server before we send
      // the didOpen burst).
      const rootDir = rootUri.startsWith('file://') ? fileURLToPath(rootUri) : rootUri;
      setImmediate(() => warmupServer(rootDir));
      continue;
    }

    // Block unsupported methods.
    if (msg.method && BLOCKED_METHODS.has(msg.method)) {
      if (msg.id !== undefined) {
        const response = JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: null,
        });
        writeMessage(process.stdout, response);
      }
      continue;
    }

    // Not blocked — forward (raw bytes unless disk-sync rewrote or consumed
    // the frame above).
    if (outFrame) child.stdin.write(outFrame);
  }
}

// ---------------------------------------------------------------------------
// Signal forwarding
// ---------------------------------------------------------------------------

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    shuttingDown = true;
    if (pollTimer) clearInterval(pollTimer);
    child.kill(sig);
  });
}
