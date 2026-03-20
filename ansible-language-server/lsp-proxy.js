#!/usr/bin/env node
// Shared LSP proxy for Claude Code plugins
//
// Sits between Claude Code and a real language server to intercept requests
// for unsupported methods. Without this, JSON-RPC -32601 error responses
// cause Claude Code's LSP client to enter an unrecoverable broken state.
//
// Usage: node lsp-proxy.js --config <path-to-proxy.json>
//
// proxy.json format:
//   { "server": ["command", "arg1", ...], "blocked": ["method/name", ...] }
//
// Server→client traffic is piped through with zero parsing.
// Client→server traffic is parsed just enough to identify blocked methods.

"use strict";

const { spawn } = require("child_process");
const { readFileSync } = require("fs");
const { resolve } = require("path");

// ---------------------------------------------------------------------------
// Load configuration
// ---------------------------------------------------------------------------

const configIdx = process.argv.indexOf("--config");
if (configIdx === -1 || !process.argv[configIdx + 1]) {
  process.stderr.write("Usage: lsp-proxy --config <path-to-proxy.json>\n");
  process.exit(1);
}

const configPath = resolve(process.argv[configIdx + 1]);
let config;
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
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
const LOG_PREFIX = `[lsp-proxy:${SERVER_CMD}]`;

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

const child = spawn(SERVER_CMD, SERVER_ARGS, {
  stdio: ["pipe", "pipe", "inherit"],
});

// Server→client: parse messages, auto-respond to server-initiated requests
// that Claude Code's LSP client does not handle (e.g. client/registerCapability).
// These are JSON-RPC requests FROM the server (they have an "id" and "method").
// If the client never responds, the server may deadlock or misbehave.

const SERVER_REQUESTS_AUTO_RESPOND = new Set([
  "client/registerCapability",
  "client/unregisterCapability",
  "workspace/configuration",
  "window/workDoneProgress/create",
]);

let serverBuffer = Buffer.alloc(0);

child.stdout.on("data", (chunk) => {
  serverBuffer = Buffer.concat([serverBuffer, chunk]);
  drainServerBuffer();
});

function drainServerBuffer() {
  while (true) {
    const delimIdx = serverBuffer.indexOf(HEADER_DELIM);
    if (delimIdx === -1) return;

    const header = serverBuffer.subarray(0, delimIdx).toString("ascii");
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
      msg = JSON.parse(bodyBytes.toString("utf8"));
    } catch {
      process.stdout.write(rawMessage);
      continue;
    }

    if (
      msg.id !== undefined &&
      msg.method &&
      SERVER_REQUESTS_AUTO_RESPOND.has(msg.method)
    ) {
      // Auto-respond to the server so it doesn't block waiting for the client.
      const ack = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: null });
      writeMessage(child.stdin, ack);
      // Don't forward to client — it can't handle these.
      continue;
    }

    // Forward everything else to the client.
    process.stdout.write(rawMessage);
  }
}

child.on("error", (err) => {
  process.stderr.write(`${LOG_PREFIX} child error: ${err.message}\n`);
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
