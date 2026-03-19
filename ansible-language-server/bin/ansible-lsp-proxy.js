#!/usr/bin/env node
// LSP proxy for ansible-language-server
//
// Sits between Claude Code and the real server to intercept requests for
// unsupported methods. Without this, error responses from the server cause
// Claude Code's LSP client to enter an unrecoverable broken state.
//
// Server→client traffic is piped through with zero parsing.
// Client→server traffic is parsed just enough to identify blocklisted methods.

"use strict";

const { spawn } = require("child_process");

// Methods the server does not implement. Requests for these get a synthetic
// null result instead of being forwarded (which would produce a -32601 error).
const BLOCKED_METHODS = new Set([
  "textDocument/documentSymbol",
  "textDocument/references",
  "textDocument/implementation",
  "textDocument/prepareCallHierarchy",
  "textDocument/callHierarchyIncomingCalls",
  "textDocument/callHierarchyOutgoingCalls",
  "workspace/symbol",
]);

// ---------------------------------------------------------------------------
// LSP message framing helpers
// ---------------------------------------------------------------------------

const HEADER_DELIM = Buffer.from("\r\n\r\n");
const CONTENT_LENGTH_RE = /^content-length:\s*(\d+)\s*$/im;

function writeMessage(stream, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  stream.write(`Content-Length: ${buf.length}\r\n\r\n`);
  stream.write(buf);
}

// ---------------------------------------------------------------------------
// Spawn the real language server
// ---------------------------------------------------------------------------

const child = spawn("ansible-language-server", ["--stdio"], {
  stdio: ["pipe", "pipe", "inherit"],
});

// Server→client: pipe raw bytes, no parsing needed.
child.stdout.pipe(process.stdout);

child.on("error", (err) => {
  process.stderr.write(`[ansible-lsp-proxy] child error: ${err.message}\n`);
  process.exit(1);
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});

// ---------------------------------------------------------------------------
// Client→server: parse messages, intercept blocked methods
// ---------------------------------------------------------------------------

let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drainBuffer();
});

process.stdin.on("end", () => {
  child.kill("SIGTERM");
});

function drainBuffer() {
  while (true) {
    // Find header/body boundary.
    const delimIdx = buffer.indexOf(HEADER_DELIM);
    if (delimIdx === -1) return;

    // Extract Content-Length from the header block.
    const header = buffer.subarray(0, delimIdx).toString("ascii");
    const match = CONTENT_LENGTH_RE.exec(header);
    if (!match) {
      // Malformed — forward as-is and hope for the best.
      child.stdin.write(buffer);
      buffer = Buffer.alloc(0);
      return;
    }

    const contentLength = parseInt(match[1], 10);
    const bodyStart = delimIdx + HEADER_DELIM.length;
    const messageEnd = bodyStart + contentLength;

    // Wait for the full body to arrive.
    if (buffer.length < messageEnd) return;

    const rawMessage = buffer.subarray(0, messageEnd);
    const bodyBytes = buffer.subarray(bodyStart, messageEnd);
    buffer = buffer.subarray(messageEnd);

    // Parse JSON to check the method.
    let msg;
    try {
      msg = JSON.parse(bodyBytes.toString("utf8"));
    } catch {
      // Unparseable — forward raw bytes.
      child.stdin.write(rawMessage);
      continue;
    }

    if (msg.method && BLOCKED_METHODS.has(msg.method)) {
      if (msg.id !== undefined) {
        // Request — synthesize a null result so the client stays happy.
        const response = JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: null,
        });
        writeMessage(process.stdout, response);
      }
      // Notifications (no id) are silently dropped.
      continue;
    }

    // Not blocked — forward the original bytes unchanged.
    child.stdin.write(rawMessage);
  }
}

// ---------------------------------------------------------------------------
// Signal forwarding
// ---------------------------------------------------------------------------

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    child.kill(sig);
  });
}
