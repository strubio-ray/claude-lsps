const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const HEADER_DELIM = Buffer.from('\r\n\r\n');
const CL_RE = /^content-length:\s*(\d+)\s*$/im;

function requireEnv() {
  const ROOT_DIR = process.env.ROOT_DIR;
  const TMP_DIR = process.env.TMP_DIR;
  const TESTS_DIR = process.env.TESTS_DIR;
  if (!(ROOT_DIR && TMP_DIR && TESTS_DIR)) {
    console.error('ROOT_DIR/TMP_DIR/TESTS_DIR must be exported');
    process.exit(2);
  }
  return { ROOT_DIR, TMP_DIR, TESTS_DIR };
}

function frameOf(obj) {
  const body = Buffer.from(JSON.stringify(obj));
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

// Parse as many complete frames as the buffer holds. The `remaining` count
// lets callers assert "no trailing garbage" when they expect a clean parse;
// silent truncation here would otherwise turn a malformed-header bug into a
// confusing "expected N frames, got N-1" assertion failure downstream.
function parseFrames(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const di = buf.indexOf(HEADER_DELIM, i);
    if (di === -1) break;
    const header = buf.subarray(i, di).toString('ascii');
    const m = CL_RE.exec(header);
    if (!m) break;
    const cl = parseInt(m[1], 10);
    const start = di + HEADER_DELIM.length;
    const end = start + cl;
    if (buf.length < end) break;
    out.push({
      raw: buf.subarray(i, end),
      body: JSON.parse(buf.subarray(start, end).toString('utf8')),
      header,
      contentLength: cl,
    });
    i = end;
  }
  out.remaining = buf.length - i;
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, { timeout = 4000, interval = 20 } = {}) {
  const start = Date.now();
  while (true) {
    const result = await predicate();
    if (result) return result;
    if (Date.now() - start > timeout) {
      throw new Error(`waitFor timed out after ${timeout}ms`);
    }
    await sleep(interval);
  }
}

function newWorkdir(rootTmp, tag) {
  const parent = path.join(rootTmp, 'wd');
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, `${tag}-`));
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
}

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function spawnProxy({ proxyJs, config, configPath, stubEnv = {} }) {
  let cfg = configPath;
  if (!cfg) {
    cfg = path.join(fs.mkdtempSync(path.join(process.env.TMP_DIR, 'cfg-')), 'proxy.json');
  }
  if (config !== undefined) fs.writeFileSync(cfg, JSON.stringify(config));

  const env = { ...process.env, ...stubEnv };
  const child = spawn(process.execPath, [proxyJs, '--config', cfg], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });
  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout.on('data', (b) => stdoutChunks.push(b));
  child.stderr.on('data', (b) => stderrChunks.push(b));
  const exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    stdoutBuf: () => Buffer.concat(stdoutChunks),
    stderrBuf: () => Buffer.concat(stderrChunks),
    stdout: () => Buffer.concat(stdoutChunks).toString('utf8'),
    stderr: () => Buffer.concat(stderrChunks).toString('utf8'),
    exited,
  };
}

// Run each scenario and exit with non-zero on the first failure. Always kill
// any spawned proxy if it's still running so a hung waitFor doesn't orphan a
// child process. SIGTERM first with a short grace window — Node only flushes
// NODE_V8_COVERAGE to disk on clean exit, so SIGKILL'ing here would drop
// coverage data on every scenario that throws and silently lower the gate.
async function _killGracefully(child, graceMs = 750) {
  if (!child || child.killed) return;
  try {
    child.kill('SIGTERM');
  } catch {}
  const exited = new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
  });
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, graceMs);
  });
  await Promise.race([exited, timeout]);
  clearTimeout(timer);
  if (child.exitCode === null && !child.killed) {
    try {
      child.kill('SIGKILL');
    } catch {}
  }
}

function dispatch(scenarios, name) {
  if (!(name && scenarios[name])) {
    console.error(`unknown scenario: ${name}`);
    console.error('available:', Object.keys(scenarios).join(', '));
    process.exit(2);
  }
  // Track every proxy a scenario spawns (some may chain multiple) so cleanup
  // can't leak a stale child.
  const activeProxies = [];
  const setProxy = (p) => {
    activeProxies.push(p);
  };
  (async () => {
    let exitCode = 0;
    try {
      await scenarios[name](setProxy);
    } catch (err) {
      console.error(err?.stack ? err.stack : String(err));
      exitCode = 1;
    } finally {
      await Promise.all(activeProxies.map((p) => _killGracefully(p?.child)));
      process.exit(exitCode);
    }
  })();
}

module.exports = {
  HEADER_DELIM,
  CL_RE,
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
};
