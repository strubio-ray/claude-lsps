#!/usr/bin/env node
// Stub LSP server for proxy harness tests. Behavior controlled by env vars.
//
//   STUB_LOG_DIR        directory for recv.log (raw bytes) and recv.jsonl
//   STUB_AUTO_INIT      "1" => respond to "initialize" with empty capabilities
//   STUB_HOVER_RESULT   "1" => respond to "textDocument/hover" with a fixed result
//   STUB_EMIT           JSON array of messages to write to stdout on startup
//   STUB_EMIT_CHUNKED   "1" => write STUB_EMIT byte-by-byte across ticks
//   STUB_RESPONSE_CHUNKED "1" => same for hover response
//   STUB_SIGNAL_LOG     file to record received signals (then exit)
//   STUB_EXIT_ON_METHOD method that causes the stub to exit with STUB_EXIT_CODE
//   STUB_EXIT_CODE      numeric exit code (default 0)

const fs = require('node:fs');
const path = require('node:path');

const LOG_DIR = process.env.STUB_LOG_DIR || '';
const AUTO_INIT = process.env.STUB_AUTO_INIT === '1';
const HOVER_RESULT = process.env.STUB_HOVER_RESULT === '1';
const EMIT_JSON = process.env.STUB_EMIT || '';
const EMIT_CHUNKED = process.env.STUB_EMIT_CHUNKED === '1';
const RESPONSE_CHUNKED = process.env.STUB_RESPONSE_CHUNKED === '1';
const SIGNAL_LOG = process.env.STUB_SIGNAL_LOG || '';
const EXIT_ON_METHOD = process.env.STUB_EXIT_ON_METHOD || '';
const EXIT_CODE = parseInt(process.env.STUB_EXIT_CODE || '0', 10);

if (LOG_DIR) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function appendRaw(buf) {
  if (LOG_DIR) fs.appendFileSync(path.join(LOG_DIR, 'recv.log'), buf);
}
function appendJson(obj) {
  if (LOG_DIR) fs.appendFileSync(path.join(LOG_DIR, 'recv.jsonl'), `${JSON.stringify(obj)}\n`);
}

function frame(body) {
  const buf = Buffer.from(JSON.stringify(body));
  const hdr = Buffer.from(`Content-Length: ${buf.length}\r\n\r\n`);
  return Buffer.concat([hdr, buf]);
}

async function writeBuf(buf, chunked) {
  if (!chunked) {
    process.stdout.write(buf);
    return;
  }
  for (let i = 0; i < buf.length; i++) {
    process.stdout.write(Buffer.from([buf[i]]));
    await new Promise((r) => setImmediate(r));
  }
}

const HEADER_DELIM = Buffer.from('\r\n\r\n');
const CL_RE = /^content-length:\s*(\d+)\s*$/im;
let buffer = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
  appendRaw(chunk);
  buffer = Buffer.concat([buffer, chunk]);
  drain();
});

process.stdin.on('end', () => {
  // Caller drives shutdown; nothing to do here.
});

function drain() {
  while (true) {
    const di = buffer.indexOf(HEADER_DELIM);
    if (di === -1) return;
    const header = buffer.subarray(0, di).toString('ascii');
    const m = CL_RE.exec(header);
    if (!m) {
      buffer = Buffer.alloc(0);
      return;
    }
    const cl = parseInt(m[1], 10);
    const start = di + HEADER_DELIM.length;
    const end = start + cl;
    if (buffer.length < end) return;
    const body = buffer.subarray(start, end);
    buffer = buffer.subarray(end);
    let msg;
    try {
      msg = JSON.parse(body.toString('utf8'));
    } catch {
      continue;
    }
    appendJson(msg);

    if (AUTO_INIT && msg.method === 'initialize' && msg.id !== undefined) {
      process.stdout.write(
        frame({
          jsonrpc: '2.0',
          id: msg.id,
          result: { capabilities: {} },
        }),
      );
    }
    if (HOVER_RESULT && msg.method === 'textDocument/hover' && msg.id !== undefined) {
      const f = frame({
        jsonrpc: '2.0',
        id: msg.id,
        result: { contents: 'hover-result' },
      });
      writeBuf(f, RESPONSE_CHUNKED).catch(() => {});
    }
    if (EXIT_ON_METHOD && msg.method === EXIT_ON_METHOD) {
      process.exit(EXIT_CODE);
    }
  }
}

(async () => {
  if (EMIT_JSON) {
    const arr = JSON.parse(EMIT_JSON);
    for (const m of arr) {
      await writeBuf(frame(m), EMIT_CHUNKED);
    }
  }
})();

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    if (SIGNAL_LOG) {
      try {
        fs.appendFileSync(SIGNAL_LOG, `${sig}\n`);
      } catch {}
    }
    process.exit(sig === 'SIGINT' ? 130 : 143);
  });
}
