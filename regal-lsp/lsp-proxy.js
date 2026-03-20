#!/usr/bin/env node
// LSP proxy with warmup support for Claude Code plugins
//
// Extends the shared LSP proxy pattern with automatic file discovery and
// textDocument/didOpen on startup. This forces language servers (like Regal)
// that defer indexing until a file is opened to begin indexing immediately
// after initialization.
//
// Usage: node lsp-proxy.js --config <path-to-proxy.json>
//
// proxy.json format:
//   {
//     "server": ["command", "arg1", ...],
//     "blocked": ["method/name", ...],
//     "warmup": { "extensions": [".rego"], "exclude": ["node_modules", ...] }
//   }

"use strict";

const { spawn } = require("child_process");
const { readFileSync, readdirSync } = require("fs");
const { resolve, join, extname } = require("path");
const { fileURLToPath, pathToFileURL } = require("url");

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
const WARMUP = config.warmup || null;
const LOG_PREFIX = `[lsp-proxy:${SERVER_CMD}]`;

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
 * Uses languageId derived from the file extension.
 */
function warmupServer(rootDir) {
  if (!WARMUP || !Array.isArray(WARMUP.extensions) || WARMUP.extensions.length === 0) {
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
    ".rego": "rego",
    ".py": "python",
    ".ts": "typescript",
    ".js": "javascript",
    ".cue": "cue",
    ".sh": "shellscript",
    ".yml": "yaml",
    ".yaml": "yaml",
    ".swift": "swift",
  };

  let version = 0;
  for (const filePath of files) {
    let content;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      continue; // Unreadable file — skip.
    }

    const ext = extname(filePath);
    const languageId = extToLang[ext] || ext.slice(1);
    const uri = pathToFileURL(filePath).href;

    const notification = JSON.stringify({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri,
          languageId,
          version: version++,
          text: content,
        },
      },
    });

    writeMessage(child.stdin, notification);
  }

  process.stderr.write(`${LOG_PREFIX} warmup: sent ${files.length} didOpen notification(s)\n`);
}

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

// ---------------------------------------------------------------------------
// State tracking for warmup trigger
// ---------------------------------------------------------------------------

let rootUri = null;
let initializeResponseSeen = false;

// ---------------------------------------------------------------------------
// Server→client: parse messages, auto-respond to server-initiated requests
// ---------------------------------------------------------------------------

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

    // Auto-respond to server-initiated requests the client can't handle.
    if (
      msg.id !== undefined &&
      msg.method &&
      SERVER_REQUESTS_AUTO_RESPOND.has(msg.method)
    ) {
      const ack = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: null });
      writeMessage(child.stdin, ack);
      continue;
    }

    // Detect the initialize response (has "capabilities" in result).
    // We use this + the subsequent "initialized" notification to trigger warmup.
    if (msg.result && msg.result.capabilities) {
      initializeResponseSeen = true;
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
// Client→server: parse messages, intercept blocked methods, trigger warmup
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
    const delimIdx = buffer.indexOf(HEADER_DELIM);
    if (delimIdx === -1) return;

    const header = buffer.subarray(0, delimIdx).toString("ascii");
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
      msg = JSON.parse(bodyBytes.toString("utf8"));
    } catch {
      child.stdin.write(rawMessage);
      continue;
    }

    // Capture rootUri from the initialize request.
    if (msg.method === "initialize" && msg.params) {
      rootUri = msg.params.rootUri || msg.params.rootPath || null;
      process.stderr.write(`${LOG_PREFIX} rootUri: ${rootUri}\n`);
    }

    // After "initialized" notification, trigger warmup.
    if (msg.method === "initialized" && initializeResponseSeen && rootUri && WARMUP) {
      // Forward the initialized notification first.
      child.stdin.write(rawMessage);

      // Then trigger warmup asynchronously (setImmediate lets the event loop
      // flush the initialized notification to the server before we send
      // the didOpen burst).
      const rootDir = rootUri.startsWith("file://")
        ? fileURLToPath(rootUri)
        : rootUri;
      setImmediate(() => warmupServer(rootDir));
      continue;
    }

    // Block unsupported methods.
    if (msg.method && BLOCKED_METHODS.has(msg.method)) {
      if (msg.id !== undefined) {
        const response = JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: null,
        });
        writeMessage(process.stdout, response);
      }
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
