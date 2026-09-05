#!/usr/bin/env node

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const {
  requireEnv,
  frameOf,
  parseFrames,
  sleep,
  waitFor,
  newWorkdir,
  readJsonLines,
  assert,
  spawnProxy,
  dispatch,
} = require('./lsp-test-utils.js');

const { ROOT_DIR, TMP_DIR, TESTS_DIR } = requireEnv();
// All plugins carry byte-identical copies of the unified proxy (enforced by
// consistency/proxy-copies-identical); scenarios spread across three copies so
// the by-hash-merged coverage gate sees the union of all exercised paths.
const BASH_PROXY = path.join(ROOT_DIR, 'bash-language-server', 'lsp-proxy.js');
const REGAL_PROXY = path.join(ROOT_DIR, 'regal-lsp', 'lsp-proxy.js');
const PYRIGHT_PROXY = path.join(ROOT_DIR, 'pyright', 'lsp-proxy.js');
const STUB = path.join(TESTS_DIR, 'helpers', 'stub-server.js');

const wd = (tag) => newWorkdir(TMP_DIR, tag);
const proxyConfig = (extra = {}) => ({ server: ['node', STUB], blocked: [], ...extra });

// Round-trip a no-op notification through the proxy: by the time the stub has
// logged it, both processes have finished synchronous setup (including signal
// handler registration in lsp-proxy.js). Replaces brittle fixed sleeps.
async function waitForHandshake(proxy, logDir) {
  const ping = { jsonrpc: '2.0', method: '$/test-ready-ping', params: {} };
  proxy.child.stdin.write(frameOf(ping));
  const log = path.join(logDir, 'recv.jsonl');
  await waitFor(
    () => {
      if (!fs.existsSync(log)) return false;
      return readJsonLines(log).some((m) => m.method === '$/test-ready-ping');
    },
    { timeout: 8000 },
  );
}

async function passthrough(setProxy) {
  const dir = wd('passthrough');
  const proxy = spawnProxy({
    proxyJs: BASH_PROXY,
    config: proxyConfig(),
    stubEnv: { STUB_LOG_DIR: dir, STUB_HOVER_RESULT: '1' },
  });
  setProxy(proxy);

  const hover = {
    jsonrpc: '2.0',
    id: 1,
    method: 'textDocument/hover',
    params: { textDocument: { uri: 'file:///x.yml' }, position: { line: 0, character: 0 } },
  };
  const sentBytes = frameOf(hover);
  proxy.child.stdin.write(sentBytes);

  await waitFor(() => parseFrames(proxy.stdoutBuf()).some((f) => f.body.id === 1));

  const resp = parseFrames(proxy.stdoutBuf()).find((f) => f.body.id === 1);
  assert(resp, 'expected response with id=1');
  assert(
    resp.body.result && resp.body.result.contents === 'hover-result',
    `unexpected response body: ${JSON.stringify(resp.body)}`,
  );

  const stubReceived = fs.readFileSync(path.join(dir, 'recv.log'));
  assert(
    stubReceived.equals(sentBytes),
    `stub bytes differ from client bytes; got ${stubReceived.length}B, sent ${sentBytes.length}B`,
  );

  proxy.child.stdin.end();
  await proxy.exited;
}

async function blockedRequest(setProxy) {
  const dir = wd('blocked-req');
  const proxy = spawnProxy({
    proxyJs: BASH_PROXY,
    config: proxyConfig({ blocked: ['textDocument/references'] }),
    stubEnv: { STUB_LOG_DIR: dir },
  });
  setProxy(proxy);

  const req = {
    jsonrpc: '2.0',
    id: 42,
    method: 'textDocument/references',
    params: { textDocument: { uri: 'file:///x' }, position: { line: 0, character: 0 } },
  };
  proxy.child.stdin.write(frameOf(req));

  await waitFor(() => parseFrames(proxy.stdoutBuf()).some((f) => f.body.id === 42));

  const resp = parseFrames(proxy.stdoutBuf()).find((f) => f.body.id === 42);
  assert(resp, 'expected synthesized response for blocked request');
  assert(resp.body.jsonrpc === '2.0', 'missing jsonrpc field');
  // NOTE: This codifies SUT behavior, not LSP spec. The JSON-RPC spec calls
  // for a -32601 (MethodNotFound) error for unsupported requests; lsp-proxy
  // currently synthesizes {result: null}. An LSP client reading this will
  // misrender as "no references" rather than "unsupported". Tracked as a
  // known proxy bug — flip these asserts when the proxy is fixed.
  assert(
    resp.body.result === null,
    `expected result:null, got ${JSON.stringify(resp.body.result)}`,
  );
  assert(resp.body.error === undefined, 'result:null and error are mutually exclusive in JSON-RPC');
  assert(resp.body.id === 42, 'blocked response id must mirror request id');
  assert(
    resp.contentLength === Buffer.from(JSON.stringify(resp.body)).length,
    'Content-Length mismatch',
  );

  const recvLog = path.join(dir, 'recv.log');
  const stubReceived = fs.existsSync(recvLog) ? fs.readFileSync(recvLog, 'utf8') : '';
  assert(!stubReceived.includes('textDocument/references'), 'stub received the blocked request');

  proxy.child.stdin.end();
  await proxy.exited;
}

async function blockedNotification(setProxy) {
  const dir = wd('blocked-notif');
  const proxy = spawnProxy({
    proxyJs: BASH_PROXY,
    config: proxyConfig({ blocked: ['textDocument/references'] }),
    stubEnv: { STUB_LOG_DIR: dir },
  });
  setProxy(proxy);

  // Sentinel idiom: send the blocked notification, then a known-non-blocked
  // notification. When the second one shows up at the stub, the first has
  // already been processed (and dropped if blocking works). Eliminates the
  // 200ms sleep race.
  proxy.child.stdin.write(
    frameOf({
      jsonrpc: '2.0',
      method: 'textDocument/references',
      params: { uri: 'file:///x' },
    }),
  );
  proxy.child.stdin.write(
    frameOf({
      jsonrpc: '2.0',
      method: '$/test-sentinel-after-blocked',
      params: {},
    }),
  );

  await waitFor(() => {
    const f = path.join(dir, 'recv.jsonl');
    return (
      fs.existsSync(f) && readJsonLines(f).some((m) => m.method === '$/test-sentinel-after-blocked')
    );
  });

  const stubFile = path.join(dir, 'recv.log');
  const stubReceived = fs.existsSync(stubFile) ? fs.readFileSync(stubFile, 'utf8') : '';
  assert(
    !stubReceived.includes('textDocument/references'),
    'stub received the blocked notification',
  );

  const out = proxy.stdoutBuf();
  assert(out.length === 0, `proxy wrote unexpected bytes to client: ${out.toString('utf8')}`);

  proxy.child.stdin.end();
  await proxy.exited;
}

async function autoAckMethod(method, setProxy) {
  const dir = wd(`auto-ack-${method.replace(/\//g, '-')}`);
  // workspace/configuration's spec-correct ack is one null per params.items
  // entry (servers index into the array — pyright/vtsls break on a bare null);
  // every other auto-acked method gets result:null.
  const isConfig = method === 'workspace/configuration';
  const serverReq = {
    jsonrpc: '2.0',
    id: 99,
    method,
    params: isConfig ? { items: [{ section: 'a' }, { section: 'b' }] } : {},
  };
  const ackMatches = (m) =>
    isConfig
      ? Array.isArray(m.result) && m.result.length === 2 && m.result.every((x) => x === null)
      : m.result === null;
  const proxy = spawnProxy({
    proxyJs: BASH_PROXY,
    config: proxyConfig(),
    stubEnv: { STUB_LOG_DIR: dir, STUB_EMIT: JSON.stringify([serverReq]) },
  });
  setProxy(proxy);

  // Wait for the proxy's auto-ack to land at the stub: id matches, result has
  // the expected shape, *and* method is absent (so we're not matching the
  // stub's outbound request being mistakenly logged as inbound).
  await waitFor(() =>
    readJsonLines(path.join(dir, 'recv.jsonl')).some(
      (m) => m.id === 99 && m.method === undefined && m.jsonrpc === '2.0' && ackMatches(m),
    ),
  );

  // Drive a sentinel notification through the proxy and wait for the stub to
  // see it. Once it has, any client-bound frame the proxy was going to emit
  // for the server-initiated request would already be in stdoutBuf.
  proxy.child.stdin.write(
    frameOf({
      jsonrpc: '2.0',
      method: '$/test-sentinel-after-autoack',
      params: {},
    }),
  );
  await waitFor(() =>
    readJsonLines(path.join(dir, 'recv.jsonl')).some(
      (m) => m.method === '$/test-sentinel-after-autoack',
    ),
  );

  const clientFrames = parseFrames(proxy.stdoutBuf());
  assert(
    !clientFrames.some((f) => f.body.id === 99 && f.body.method === method),
    `client unexpectedly received server-initiated ${method}`,
  );

  proxy.child.stdin.end();
  await proxy.exited;
}

// Negative case: a server-initiated request that is NOT in the auto-ack set
// must be forwarded to the client, not synthetically answered by the proxy.
async function serverRequestForwardedWhenNotAutoAcked(setProxy) {
  const dir = wd('server-req-forwarded');
  const method = 'window/showMessageRequest';
  const serverReq = {
    jsonrpc: '2.0',
    id: 77,
    method,
    params: { type: 3, message: 'pick one', actions: [] },
  };
  const proxy = spawnProxy({
    proxyJs: BASH_PROXY,
    config: proxyConfig(),
    stubEnv: { STUB_LOG_DIR: dir, STUB_EMIT: JSON.stringify([serverReq]) },
  });
  setProxy(proxy);

  await waitFor(() =>
    parseFrames(proxy.stdoutBuf()).some((f) => f.body.id === 77 && f.body.method === method),
  );

  const clientFrames = parseFrames(proxy.stdoutBuf());
  const fwd = clientFrames.find((f) => f.body.id === 77 && f.body.method === method);
  assert(fwd, `expected ${method} to be forwarded to client`);
  // Proxy must not also pre-answer; if it did, we'd see a response frame for id=77.
  const ackedAtStub = readJsonLines(path.join(dir, 'recv.jsonl')).some(
    (m) => m.id === 77 && m.result !== undefined,
  );
  assert(!ackedAtStub, 'proxy auto-answered a method not in the auto-ack set');

  proxy.child.stdin.end();
  await proxy.exited;
}

async function splitBuffer(setProxy) {
  const dir = wd('split');
  const proxy = spawnProxy({
    proxyJs: BASH_PROXY,
    config: proxyConfig(),
    stubEnv: { STUB_LOG_DIR: dir, STUB_HOVER_RESULT: '1', STUB_RESPONSE_CHUNKED: '1' },
  });
  setProxy(proxy);

  const hover = {
    jsonrpc: '2.0',
    id: 7,
    method: 'textDocument/hover',
    params: { textDocument: { uri: 'file:///x.yml' }, position: { line: 0, character: 0 } },
  };
  const buf = frameOf(hover);
  for (let i = 0; i < buf.length; i++) {
    proxy.child.stdin.write(Buffer.from([buf[i]]));
    await new Promise((r) => setImmediate(r));
  }

  await waitFor(() => parseFrames(proxy.stdoutBuf()).some((f) => f.body.id === 7), {
    timeout: 6000,
  });

  const stubMsgs = readJsonLines(path.join(dir, 'recv.jsonl'));
  assert(
    stubMsgs.some((m) => m.id === 7 && m.method === 'textDocument/hover'),
    'stub did not reconstruct hover request from byte-split input',
  );

  const resp = parseFrames(proxy.stdoutBuf()).find((f) => f.body.id === 7);
  assert(
    resp && resp.body.result.contents === 'hover-result',
    'client did not reconstruct hover response from byte-split server output',
  );

  proxy.child.stdin.end();
  await proxy.exited;
}

async function malformedHeaderForwarded(setProxy) {
  const dir = wd('malformed-header');
  const proxy = spawnProxy({
    proxyJs: BASH_PROXY,
    config: proxyConfig(),
    stubEnv: { STUB_LOG_DIR: dir },
  });
  setProxy(proxy);

  const bytes = Buffer.from('X-Header: foo\r\n\r\nopaque-body-bytes');
  proxy.child.stdin.write(bytes);
  await waitFor(() => {
    const f = path.join(dir, 'recv.log');
    return fs.existsSync(f) && fs.statSync(f).size >= bytes.length;
  });
  const received = fs.readFileSync(path.join(dir, 'recv.log'));
  assert(
    received.equals(bytes),
    `stub did not receive malformed bytes verbatim; got ${received.length}B, sent ${bytes.length}B`,
  );
  proxy.child.stdin.end();
  await proxy.exited;
}

async function unparseableBodyForwarded(setProxy) {
  const dir = wd('unparseable-body');
  const proxy = spawnProxy({
    proxyJs: BASH_PROXY,
    config: proxyConfig({ blocked: ['textDocument/references'] }),
    stubEnv: { STUB_LOG_DIR: dir },
  });
  setProxy(proxy);

  const body = Buffer.from('{not-json');
  const wire = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
  proxy.child.stdin.write(wire);
  await waitFor(() => {
    const f = path.join(dir, 'recv.log');
    return fs.existsSync(f) && fs.statSync(f).size >= wire.length;
  });
  const received = fs.readFileSync(path.join(dir, 'recv.log'));
  assert(
    received.equals(wire),
    `stub did not receive raw frame; got ${received.length}B, sent ${wire.length}B`,
  );
  proxy.child.stdin.end();
  await proxy.exited;
}

async function serverToClientByteIdentical(setProxy) {
  // Emit a notification followed by a sentinel terminator. Once the terminator
  // arrives at the client, the proxy has finished emitting everything queued
  // before it — observable bound on completion replaces the 80ms sleep.
  const notif = {
    jsonrpc: '2.0',
    method: 'window/showMessage',
    params: { type: 3, message: 'hello-from-server' },
  };
  const terminator = {
    jsonrpc: '2.0',
    method: '$/test-terminator',
    params: {},
  };
  const expected = Buffer.concat([frameOf(notif), frameOf(terminator)]);
  const proxy = spawnProxy({
    proxyJs: BASH_PROXY,
    config: proxyConfig(),
    stubEnv: { STUB_EMIT: JSON.stringify([notif, terminator]) },
  });
  setProxy(proxy);

  await waitFor(() => proxy.stdoutBuf().length >= expected.length);
  const got = proxy.stdoutBuf();
  assert(
    got.equals(expected),
    `server->client bytes differ; got ${got.length}B '${got.toString('utf8')}', expected '${expected.toString('utf8')}'`,
  );
  proxy.child.stdin.end();
  await proxy.exited;
}

// Framing parity for regal-lsp/lsp-proxy.js: identical pass-through behavior.
// Without this, a future divergence between the two proxies would slip past
// the suite (proxy tests target BASH_PROXY, warmup tests target REGAL_PROXY
// but only exercise the warmup-specific code paths).
async function regalPassthroughParity(setProxy) {
  const dir = wd('regal-passthrough');
  const proxy = spawnProxy({
    proxyJs: REGAL_PROXY,
    config: proxyConfig(),
    stubEnv: { STUB_LOG_DIR: dir, STUB_HOVER_RESULT: '1' },
  });
  setProxy(proxy);

  const hover = {
    jsonrpc: '2.0',
    id: 11,
    method: 'textDocument/hover',
    params: { textDocument: { uri: 'file:///x.rego' }, position: { line: 0, character: 0 } },
  };
  const sentBytes = frameOf(hover);
  proxy.child.stdin.write(sentBytes);

  await waitFor(() => parseFrames(proxy.stdoutBuf()).some((f) => f.body.id === 11));

  const resp = parseFrames(proxy.stdoutBuf()).find((f) => f.body.id === 11);
  assert(
    resp?.body.result && resp.body.result.contents === 'hover-result',
    // biome-ignore lint/complexity/useOptionalChain: Preserve null in the emitted failure diagnostic.
    `regal proxy passthrough failed: ${JSON.stringify(resp && resp.body)}`,
  );

  const stubReceived = fs.readFileSync(path.join(dir, 'recv.log'));
  assert(
    stubReceived.equals(sentBytes),
    `regal stub bytes differ from client bytes; got ${stubReceived.length}B, sent ${sentBytes.length}B`,
  );

  proxy.child.stdin.end();
  await proxy.exited;
}

async function regalBlockedRequestParity(setProxy) {
  const dir = wd('regal-blocked');
  const proxy = spawnProxy({
    proxyJs: REGAL_PROXY,
    config: proxyConfig({ blocked: ['textDocument/references'] }),
    stubEnv: { STUB_LOG_DIR: dir },
  });
  setProxy(proxy);

  proxy.child.stdin.write(
    frameOf({
      jsonrpc: '2.0',
      id: 88,
      method: 'textDocument/references',
      params: { textDocument: { uri: 'file:///x.rego' }, position: { line: 0, character: 0 } },
    }),
  );
  await waitFor(() => parseFrames(proxy.stdoutBuf()).some((f) => f.body.id === 88));
  const resp = parseFrames(proxy.stdoutBuf()).find((f) => f.body.id === 88);
  assert(
    resp && resp.body.result === null,
    'regal proxy did not synthesize result:null for blocked request',
  );

  const recv = fs.existsSync(path.join(dir, 'recv.log'))
    ? fs.readFileSync(path.join(dir, 'recv.log'), 'utf8')
    : '';
  assert(!recv.includes('textDocument/references'), 'regal stub received the blocked request');

  proxy.child.stdin.end();
  await proxy.exited;
}

async function signalForwarded(sig, setProxy) {
  const dir = wd(`signal-${sig.toLowerCase()}`);
  const sigLog = path.join(dir, 'signals.log');
  const proxy = spawnProxy({
    proxyJs: BASH_PROXY,
    config: proxyConfig(),
    stubEnv: { STUB_LOG_DIR: dir, STUB_SIGNAL_LOG: sigLog },
  });
  setProxy(proxy);

  await waitForHandshake(proxy, dir);
  proxy.child.kill(sig);
  await proxy.exited;

  assert(fs.existsSync(sigLog), `stub did not record any signal (${sig})`);
  const recorded = fs.readFileSync(sigLog, 'utf8');
  assert(recorded.includes(sig), `stub did not record ${sig}; got: ${recorded}`);
}

async function childExitCodePropagated(setProxy) {
  const proxy = spawnProxy({
    proxyJs: BASH_PROXY,
    config: proxyConfig(),
    stubEnv: { STUB_EXIT_ON_METHOD: '$/please-exit', STUB_EXIT_CODE: '42' },
  });
  setProxy(proxy);
  proxy.child.stdin.write(frameOf({ jsonrpc: '2.0', method: '$/please-exit', params: {} }));
  const result = await proxy.exited;
  assert(
    result.code === 42,
    `expected proxy exit code 42, got code=${result.code} signal=${result.signal}`,
  );
}

async function stdinEofTerminatesChild(setProxy) {
  const dir = wd('stdin-eof');
  const sigLog = path.join(dir, 'signals.log');
  const proxy = spawnProxy({
    proxyJs: BASH_PROXY,
    config: proxyConfig(),
    stubEnv: { STUB_LOG_DIR: dir, STUB_SIGNAL_LOG: sigLog },
  });
  setProxy(proxy);

  await waitForHandshake(proxy, dir);
  proxy.child.stdin.end();
  await proxy.exited;

  assert(fs.existsSync(sigLog), 'stub did not record any signal on proxy stdin EOF');
  const recorded = fs.readFileSync(sigLog, 'utf8');
  assert(recorded.includes('SIGTERM'), `expected SIGTERM after stdin EOF; got: ${recorded}`);
}

async function runProxyExpectFailure(args, { stdin = 'ignore' } = {}) {
  const child = spawn(process.execPath, args, { stdio: [stdin, 'pipe', 'pipe'] });
  const stderrChunks = [];
  child.stderr.on('data', (b) => stderrChunks.push(b));
  const code = await new Promise((resolve) => child.on('exit', resolve));
  return { code, stderr: Buffer.concat(stderrChunks).toString('utf8') };
}

async function configMissing() {
  const { code, stderr } = await runProxyExpectFailure([BASH_PROXY]);
  assert(code !== 0, `expected non-zero exit; got ${code}`);
  assert(
    /Usage:/.test(stderr) && /--config/.test(stderr),
    `expected 'Usage:' with --config in stderr; got: ${stderr}`,
  );
}

async function configUnreadable() {
  const { code, stderr } = await runProxyExpectFailure([
    BASH_PROXY,
    '--config',
    '/no/such/file.json',
  ]);
  assert(code !== 0, `expected non-zero exit; got ${code}`);
  assert(/Failed to read config/i.test(stderr), `expected read-failure message; got: ${stderr}`);
}

async function configEmptyServer() {
  const dir = wd('empty-server');
  const cfg = path.join(dir, 'proxy.json');
  fs.writeFileSync(cfg, JSON.stringify({ server: [], blocked: [] }));
  const { code, stderr } = await runProxyExpectFailure([BASH_PROXY, '--config', cfg]);
  assert(code !== 0, `expected non-zero exit; got ${code}`);
  assert(/non-empty array/i.test(stderr), `expected non-empty-array message; got: ${stderr}`);
}

async function childSpawnError() {
  const dir = wd('spawn-error');
  const cfg = path.join(dir, 'proxy.json');
  fs.writeFileSync(
    cfg,
    JSON.stringify({
      server: ['/no/such/binary/__definitely_not_there__', '--stdio'],
      blocked: [],
    }),
  );
  const { code, stderr } = await runProxyExpectFailure([BASH_PROXY, '--config', cfg], {
    stdin: 'pipe',
  });
  assert(code !== 0, `expected non-zero exit on spawn ENOENT; got ${code}`);
  assert(
    /child error/i.test(stderr) || /ENOENT/.test(stderr),
    `expected child-error message in stderr; got: ${stderr}`,
  );
}

// ---------------------------------------------------------------------------
// Disk-sync scenarios (unified proxy "sync" feature). Fast poll (60ms) keeps
// the two-tick stability gate quick. Targets the pyright copy so coverage
// spreads across copies (merged by hash in the gate).
// ---------------------------------------------------------------------------

const { pathToFileURL } = require('node:url');

function syncSetup(tag, { config = {}, text = 'one\n' } = {}) {
  const dir = wd(tag);
  const docPath = path.join(dir, 'doc.py');
  fs.writeFileSync(docPath, text);
  const uri = pathToFileURL(docPath).href;
  const proxy = spawnProxy({
    proxyJs: PYRIGHT_PROXY,
    config: proxyConfig({ sync: { pollMs: 60 }, ...config }),
    stubEnv: { STUB_LOG_DIR: dir, ...(config.warmup ? { STUB_AUTO_INIT: '1' } : {}) },
  });
  return { dir, docPath, uri, proxy };
}

function didOpenFrame(uri, text, version = 1) {
  return frameOf({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: { textDocument: { uri, languageId: 'python', version, text } },
  });
}

const stubMsgs = (dir) => readJsonLines(path.join(dir, 'recv.jsonl'));
const injectedChanges = (dir, uri) =>
  stubMsgs(dir).filter(
    (m) => m.method === 'textDocument/didChange' && m.params.textDocument.uri === uri,
  );

// Disk-only edit to an open document → proxy injects didChange + didSave.
async function syncInjectsOnDiskEdit(setProxy) {
  const { dir, docPath, uri, proxy } = syncSetup('sync-inject');
  setProxy(proxy);

  proxy.child.stdin.write(didOpenFrame(uri, 'one\n'));
  await waitFor(() => stubMsgs(dir).some((m) => m.method === 'textDocument/didOpen'));

  fs.writeFileSync(docPath, 'two\n');
  await waitFor(
    () => injectedChanges(dir, uri).some((m) => m.params.contentChanges[0].text === 'two\n'),
    { timeout: 6000 },
  );

  const change = injectedChanges(dir, uri).find((m) => m.params.contentChanges[0].text === 'two\n');
  assert(
    change.params.textDocument.version === 2,
    `expected injected version 2, got ${change.params.textDocument.version}`,
  );
  assert(
    change.params.contentChanges[0].range === undefined,
    'injected didChange must be a full-document change (no range)',
  );

  // didSave follows the didChange for save-triggered linters.
  await waitFor(() =>
    stubMsgs(dir).some(
      (m) => m.method === 'textDocument/didSave' && m.params.textDocument.uri === uri,
    ),
  );
  const msgs = stubMsgs(dir);
  const iChange = msgs.findIndex((m) => m.method === 'textDocument/didChange');
  const iSave = msgs.findIndex((m) => m.method === 'textDocument/didSave');
  assert(iChange < iSave, 'didChange must precede didSave');

  proxy.child.stdin.end();
  await proxy.exited;
}

// Client didChange reconciles (buffer + version), then a later disk-only edit
// STILL syncs — the regression the wire-tap findings forced (no back-off).
async function syncReconcilesClientDidChange(setProxy) {
  const { dir, docPath, uri, proxy } = syncSetup('sync-reconcile');
  setProxy(proxy);

  proxy.child.stdin.write(didOpenFrame(uri, 'one\n'));
  // Client's own edit, Edit-tool style: disk write + full-text didChange v5.
  fs.writeFileSync(docPath, 'five\n');
  proxy.child.stdin.write(
    frameOf({
      jsonrpc: '2.0',
      method: 'textDocument/didChange',
      params: { textDocument: { uri, version: 5 }, contentChanges: [{ text: 'five\n' }] },
    }),
  );
  await waitFor(() =>
    stubMsgs(dir).some(
      (m) => m.method === 'textDocument/didChange' && m.params.textDocument.version === 5,
    ),
  );

  // Give the poll a couple ticks to see the client-written disk state; it must
  // NOT inject for it (disk == buffer after reconciliation).
  await sleep(200);
  assert(
    injectedChanges(dir, uri).length === 1,
    "proxy injected for the client's own write (reconciliation failed)",
  );

  // Now the out-of-band edit — the injected version must continue past 5.
  fs.writeFileSync(docPath, 'six\n');
  await waitFor(
    () => injectedChanges(dir, uri).some((m) => m.params.contentChanges[0].text === 'six\n'),
    { timeout: 6000 },
  );
  const injected = injectedChanges(dir, uri).find(
    (m) => m.params.contentChanges[0].text === 'six\n',
  );
  assert(
    injected.params.textDocument.version === 6,
    `expected injected version 6 (max(client 5)+1), got ${injected.params.textDocument.version}`,
  );

  proxy.child.stdin.end();
  await proxy.exited;
}

// An incremental (range-based) client didChange makes the buffer
// unreconstructable — disk-sync must go quiet for that document.
async function syncIncrementalDisables(setProxy) {
  const { dir, docPath, uri, proxy } = syncSetup('sync-incremental');
  setProxy(proxy);

  proxy.child.stdin.write(didOpenFrame(uri, 'one\n'));
  proxy.child.stdin.write(
    frameOf({
      jsonrpc: '2.0',
      method: 'textDocument/didChange',
      params: {
        textDocument: { uri, version: 2 },
        contentChanges: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
            text: 'two',
          },
        ],
      },
    }),
  );
  await waitFor(() => /disk-sync disabled/.test(proxy.stderr()));

  fs.writeFileSync(docPath, 'three\n');
  await sleep(300); // several poll ticks
  assert(
    !injectedChanges(dir, uri).some((m) => m.params.contentChanges[0].text === 'three\n'),
    'proxy injected for a document with an unreconstructable buffer',
  );

  proxy.child.stdin.end();
  await proxy.exited;
}

// A later full-text didChange re-establishes the buffer after an incremental
// one disabled sync — disk-sync must resume ([incremental, fulltext] order).
async function syncResyncAfterFulltext(setProxy) {
  const { dir, docPath, uri, proxy } = syncSetup('sync-resync');
  setProxy(proxy);

  proxy.child.stdin.write(didOpenFrame(uri, 'one\n'));
  proxy.child.stdin.write(
    frameOf({
      jsonrpc: '2.0',
      method: 'textDocument/didChange',
      params: {
        textDocument: { uri, version: 2 },
        contentChanges: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
            text: 'two',
          },
        ],
      },
    }),
  );
  await waitFor(() => /disk-sync disabled/.test(proxy.stderr()));

  // Full-document replacement restores syncability.
  proxy.child.stdin.write(
    frameOf({
      jsonrpc: '2.0',
      method: 'textDocument/didChange',
      params: { textDocument: { uri, version: 3 }, contentChanges: [{ text: 'three\n' }] },
    }),
  );
  await waitFor(() => /disk-sync re-enabled/.test(proxy.stderr()));

  fs.writeFileSync(docPath, 'four\n');
  await waitFor(
    () => injectedChanges(dir, uri).some((m) => m.params.contentChanges[0].text === 'four\n'),
    { timeout: 6000 },
  );
  const injected = injectedChanges(dir, uri).find(
    (m) => m.params.contentChanges[0].text === 'four\n',
  );
  assert(
    injected.params.textDocument.version === 4,
    `expected injected v4 after resync, got v${injected.params.textDocument.version}`,
  );

  proxy.child.stdin.end();
  await proxy.exited;
}

// mtime churn with identical content (touch, atomic same-content rewrite)
// must not inject; didClose must stop tracking entirely.
async function syncNoopAndDidClose(setProxy) {
  const { dir, docPath, uri, proxy } = syncSetup('sync-noop-close');
  setProxy(proxy);

  proxy.child.stdin.write(didOpenFrame(uri, 'one\n'));
  await waitFor(() => stubMsgs(dir).some((m) => m.method === 'textDocument/didOpen'));

  fs.writeFileSync(docPath, 'one\n'); // same content, new mtime
  await sleep(300);
  assert(injectedChanges(dir, uri).length === 0, 'proxy injected for a content-identical rewrite');

  proxy.child.stdin.write(
    frameOf({
      jsonrpc: '2.0',
      method: 'textDocument/didClose',
      params: { textDocument: { uri } },
    }),
  );
  await waitFor(() => stubMsgs(dir).some((m) => m.method === 'textDocument/didClose'));
  fs.writeFileSync(docPath, 'two\n');
  await sleep(300);
  assert(injectedChanges(dir, uri).length === 0, 'proxy injected for a closed document');

  proxy.child.stdin.end();
  await proxy.exited;
}

// sync: false disables the feature wholesale.
async function syncDisabledByConfig(setProxy) {
  const dir = wd('sync-disabled');
  const docPath = path.join(dir, 'doc.py');
  fs.writeFileSync(docPath, 'one\n');
  const uri = pathToFileURL(docPath).href;
  const proxy = spawnProxy({
    proxyJs: PYRIGHT_PROXY,
    config: proxyConfig({ sync: false }),
    stubEnv: { STUB_LOG_DIR: dir },
  });
  setProxy(proxy);

  proxy.child.stdin.write(didOpenFrame(uri, 'one\n'));
  await waitFor(() => stubMsgs(dir).some((m) => m.method === 'textDocument/didOpen'));
  fs.writeFileSync(docPath, 'two\n');
  await sleep(300);
  assert(injectedChanges(dir, uri).length === 0, 'sync:false still injected');

  proxy.child.stdin.end();
  await proxy.exited;
}

// Deleting a tracked file injects didClose (server clears diagnostics);
// recreating it reopens with disk content; a client didClose after the
// proxy's own close is swallowed (never closed twice).
async function syncDeleteAndReappear(setProxy) {
  const { dir, docPath, uri, proxy } = syncSetup('sync-delete');
  setProxy(proxy);

  proxy.child.stdin.write(didOpenFrame(uri, 'one\n'));
  await waitFor(() => stubMsgs(dir).some((m) => m.method === 'textDocument/didOpen'));

  fs.unlinkSync(docPath);
  await waitFor(
    () =>
      stubMsgs(dir).some(
        (m) => m.method === 'textDocument/didClose' && m.params.textDocument.uri === uri,
      ),
    { timeout: 6000 },
  );

  // Reappearance (e.g. git checkout back): reopen with the new disk content.
  fs.writeFileSync(docPath, 'reborn\n');
  await waitFor(
    () =>
      stubMsgs(dir).some(
        (m) => m.method === 'textDocument/didOpen' && m.params.textDocument.text === 'reborn\n',
      ),
    { timeout: 6000 },
  );
  const reopen = stubMsgs(dir).find(
    (m) => m.method === 'textDocument/didOpen' && m.params.textDocument.text === 'reborn\n',
  );
  assert(reopen.params.textDocument.version > 1, 'reopen must bump the version');

  // Disk-sync must keep working after the reopen.
  fs.writeFileSync(docPath, 'again\n');
  await waitFor(
    () => injectedChanges(dir, uri).some((m) => m.params.contentChanges[0].text === 'again\n'),
    { timeout: 6000 },
  );

  // Delete again so the proxy closes, then have the CLIENT close: the proxy
  // must swallow it (exactly one didClose on the wire for this second cycle).
  fs.unlinkSync(docPath);
  await waitFor(
    () => stubMsgs(dir).filter((m) => m.method === 'textDocument/didClose').length >= 2,
    { timeout: 6000 },
  );
  proxy.child.stdin.write(
    frameOf({
      jsonrpc: '2.0',
      method: 'textDocument/didClose',
      params: { textDocument: { uri } },
    }),
  );
  proxy.child.stdin.write(
    frameOf({ jsonrpc: '2.0', method: '$/sentinel-after-close', params: {} }),
  );
  await waitFor(() => stubMsgs(dir).some((m) => m.method === '$/sentinel-after-close'));
  assert(
    stubMsgs(dir).filter((m) => m.method === 'textDocument/didClose').length === 2,
    'client didClose after proxy close must be swallowed, not forwarded',
  );

  proxy.child.stdin.end();
  await proxy.exited;
}

// After an injection advanced the server-side version, a client didChange
// with a lagging version is rebased to tracked+1 so versions stay monotonic.
async function syncVersionRebase(setProxy) {
  const { dir, docPath, uri, proxy } = syncSetup('sync-rebase');
  setProxy(proxy);

  proxy.child.stdin.write(didOpenFrame(uri, 'one\n'));
  await waitFor(() => stubMsgs(dir).some((m) => m.method === 'textDocument/didOpen'));

  // Out-of-band edit → injected didChange v2.
  fs.writeFileSync(docPath, 'two\n');
  await waitFor(() => injectedChanges(dir, uri).some((m) => m.params.textDocument.version === 2), {
    timeout: 6000,
  });

  // Client's own next edit still carries ITS counter (v2) — must arrive as v3.
  fs.writeFileSync(docPath, 'three\n'); // Edit-tool style: disk write + didChange
  proxy.child.stdin.write(
    frameOf({
      jsonrpc: '2.0',
      method: 'textDocument/didChange',
      params: { textDocument: { uri, version: 2 }, contentChanges: [{ text: 'three\n' }] },
    }),
  );
  await waitFor(
    () => injectedChanges(dir, uri).some((m) => m.params.contentChanges[0].text === 'three\n'),
    { timeout: 6000 },
  );
  const rebased = injectedChanges(dir, uri).find(
    (m) => m.params.contentChanges[0].text === 'three\n',
  );
  assert(
    rebased.params.textDocument.version === 3,
    `expected client v2 rebased to v3, got v${rebased.params.textDocument.version}`,
  );

  // And the next injection continues past the rebased version.
  fs.writeFileSync(docPath, 'four\n');
  await waitFor(
    () => injectedChanges(dir, uri).some((m) => m.params.contentChanges[0].text === 'four\n'),
    { timeout: 6000 },
  );
  const next = injectedChanges(dir, uri).find((m) => m.params.contentChanges[0].text === 'four\n');
  assert(
    next.params.textDocument.version === 4,
    `expected injected v4 after rebase, got v${next.params.textDocument.version}`,
  );

  proxy.child.stdin.end();
  await proxy.exited;
}

// Warmup-opened documents enroll in disk-sync: edit a warmup-opened file on
// disk and the proxy must inject for it, even though the client never sent
// didOpen.
async function syncTracksWarmupOpens(setProxy) {
  const { dir, docPath, uri, proxy } = syncSetup('sync-warmup', {
    config: { warmup: { extensions: ['.py'], exclude: [] } },
  });
  setProxy(proxy);

  // Drive initialize (stub AUTO_INIT answers) then initialized to trigger warmup.
  proxy.child.stdin.write(
    frameOf({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { rootUri: pathToFileURL(dir).href },
    }),
  );
  await waitFor(() => parseFrames(proxy.stdoutBuf()).some((f) => f.body.id === 1));
  proxy.child.stdin.write(frameOf({ jsonrpc: '2.0', method: 'initialized', params: {} }));
  await waitFor(() => /warmup: sent \d+ didOpen/.test(proxy.stderr()));
  assert(
    stubMsgs(dir).some(
      (m) => m.method === 'textDocument/didOpen' && m.params.textDocument.uri === uri,
    ),
    'warmup did not open the fixture file',
  );

  fs.writeFileSync(docPath, 'changed\n');
  await waitFor(
    () => injectedChanges(dir, uri).some((m) => m.params.contentChanges[0].text === 'changed\n'),
    { timeout: 6000 },
  );

  proxy.child.stdin.end();
  await proxy.exited;
}

// Normal shutdown (client closes stdin) SIGTERMs a server that dies BY the
// signal (exit code null); the proxy must report that as success, not 1.
async function stdinEofExitCodeZero(setProxy) {
  const proxy = spawnProxy({
    proxyJs: BASH_PROXY,
    // Inert server with no signal handler — dies by SIGTERM with code=null.
    config: { server: ['node', '-e', 'setInterval(() => {}, 1000)'], blocked: [] },
  });
  setProxy(proxy);
  await sleep(300); // let the child spawn
  proxy.child.stdin.end();
  const result = await proxy.exited;
  assert(
    result.code === 0,
    `expected exit 0 on clean stdin-EOF shutdown, got code=${result.code} signal=${result.signal}`,
  );
}

// Warmup must not re-open a document the client already opened (open-after-
// open is spec-undefined; Regal drops diagnostics on it).
async function warmupSkipsClientOpenedDocs(setProxy) {
  const dir = wd('warmup-dedup');
  const mine = path.join(dir, 'mine.py');
  const other = path.join(dir, 'other.py');
  fs.writeFileSync(mine, 'mine\n');
  fs.writeFileSync(other, 'other\n');
  const mineUri = pathToFileURL(mine).href;
  const otherUri = pathToFileURL(other).href;
  const proxy = spawnProxy({
    proxyJs: PYRIGHT_PROXY,
    config: proxyConfig({ warmup: { extensions: ['.py'], exclude: [] }, sync: { pollMs: 60 } }),
    stubEnv: { STUB_LOG_DIR: dir, STUB_AUTO_INIT: '1' },
  });
  setProxy(proxy);

  proxy.child.stdin.write(
    frameOf({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { rootUri: pathToFileURL(dir).href },
    }),
  );
  await waitFor(() => parseFrames(proxy.stdoutBuf()).some((f) => f.body.id === 1));
  // initialized + the client's own didOpen in one write: the didOpen frame is
  // processed synchronously before the setImmediate-deferred warmup runs.
  proxy.child.stdin.write(
    Buffer.concat([
      frameOf({ jsonrpc: '2.0', method: 'initialized', params: {} }),
      didOpenFrame(mineUri, 'mine\n'),
    ]),
  );
  await waitFor(() => /warmup: sent \d+ didOpen/.test(proxy.stderr()));

  const opens = stubMsgs(dir).filter((m) => m.method === 'textDocument/didOpen');
  assert(
    opens.filter((m) => m.params.textDocument.uri === mineUri).length === 1,
    'warmup re-opened a client-opened document',
  );
  assert(
    opens.some((m) => m.params.textDocument.uri === otherUri),
    'warmup skipped a file the client had NOT opened',
  );
  assert(
    /warmup: sent 1 didOpen/.test(proxy.stderr()),
    'warmup sent-count should reflect the dedup skip',
  );

  proxy.child.stdin.end();
  await proxy.exited;
}

// The reverse warmup race: warmup opened a file, the client opens it later.
// The proxy must translate the client's didOpen into a full-text didChange
// (never a second didOpen), and disk-sync must keep working afterwards.
async function warmupThenClientOpenTranslated(setProxy) {
  const dir = wd('warmup-open-translate');
  const docPath = path.join(dir, 'doc.py');
  fs.writeFileSync(docPath, 'from-disk\n');
  const uri = pathToFileURL(docPath).href;
  const proxy = spawnProxy({
    proxyJs: PYRIGHT_PROXY,
    config: proxyConfig({ warmup: { extensions: ['.py'], exclude: [] }, sync: { pollMs: 60 } }),
    stubEnv: { STUB_LOG_DIR: dir, STUB_AUTO_INIT: '1' },
  });
  setProxy(proxy);

  proxy.child.stdin.write(
    frameOf({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { rootUri: pathToFileURL(dir).href },
    }),
  );
  await waitFor(() => parseFrames(proxy.stdoutBuf()).some((f) => f.body.id === 1));
  proxy.child.stdin.write(frameOf({ jsonrpc: '2.0', method: 'initialized', params: {} }));
  await waitFor(() => /warmup: sent 1 didOpen/.test(proxy.stderr()));

  // Client now opens the warmup-opened file with its own buffer content.
  proxy.child.stdin.write(didOpenFrame(uri, 'client-buffer\n'));
  await waitFor(
    () =>
      injectedChanges(dir, uri).some((m) => m.params.contentChanges[0].text === 'client-buffer\n'),
    { timeout: 6000 },
  );

  const opens = stubMsgs(dir).filter(
    (m) => m.method === 'textDocument/didOpen' && m.params.textDocument.uri === uri,
  );
  assert(opens.length === 1, `expected exactly 1 didOpen on the wire, got ${opens.length}`);
  const translated = injectedChanges(dir, uri).find(
    (m) => m.params.contentChanges[0].text === 'client-buffer\n',
  );
  assert(
    translated.params.textDocument.version > opens[0].params.textDocument.version,
    "translated didChange version must exceed the warmup open's version",
  );

  // Disk-sync must keep working with the reconciled buffer.
  fs.writeFileSync(docPath, 'after\n');
  await waitFor(
    () => injectedChanges(dir, uri).some((m) => m.params.contentChanges[0].text === 'after\n'),
    { timeout: 6000 },
  );

  proxy.child.stdin.end();
  await proxy.exited;
}

const SCENARIOS = {
  passthrough: passthrough,
  'passthrough-server-to-client': serverToClientByteIdentical,
  'blocked-request': blockedRequest,
  'blocked-notification': blockedNotification,
  'auto-ack-register': (setProxy) => autoAckMethod('client/registerCapability', setProxy),
  'auto-ack-unregister': (setProxy) => autoAckMethod('client/unregisterCapability', setProxy),
  'auto-ack-configuration': (setProxy) => autoAckMethod('workspace/configuration', setProxy),
  'auto-ack-workdone': (setProxy) => autoAckMethod('window/workDoneProgress/create', setProxy),
  'server-req-forwarded': serverRequestForwardedWhenNotAutoAcked,
  'split-buffer': splitBuffer,
  'malformed-header-forwarded': malformedHeaderForwarded,
  'unparseable-body-forwarded': unparseableBodyForwarded,
  sigterm: (setProxy) => signalForwarded('SIGTERM', setProxy),
  sigint: (setProxy) => signalForwarded('SIGINT', setProxy),
  'exit-code-propagated': childExitCodePropagated,
  'stdin-eof': stdinEofTerminatesChild,
  'config-missing': configMissing,
  'config-unreadable': configUnreadable,
  'config-empty-server': configEmptyServer,
  'child-spawn-error': childSpawnError,
  'regal-passthrough': regalPassthroughParity,
  'regal-blocked-request': regalBlockedRequestParity,
  'sync-injects-on-disk-edit': syncInjectsOnDiskEdit,
  'sync-reconciles-client-didchange': syncReconcilesClientDidChange,
  'sync-incremental-disables': syncIncrementalDisables,
  'sync-resync-after-fulltext': syncResyncAfterFulltext,
  'sync-noop-and-didclose': syncNoopAndDidClose,
  'sync-disabled-by-config': syncDisabledByConfig,
  'sync-tracks-warmup-opens': syncTracksWarmupOpens,
  'sync-delete-and-reappear': syncDeleteAndReappear,
  'sync-version-rebase': syncVersionRebase,
  'stdin-eof-exit-code': stdinEofExitCodeZero,
  'warmup-skips-client-opened': warmupSkipsClientOpenedDocs,
  'warmup-then-client-open-translated': warmupThenClientOpenTranslated,
};

dispatch(SCENARIOS, process.argv[2]);
