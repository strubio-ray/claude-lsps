#!/usr/bin/env node
// Latency harness for the marketplace LSPs. NOT a pass/fail suite — it prints a
// table of numbers you compare across runs. For each installed server it does a
// cold spawn and measures:
//
//   ready       spawn -> initialize response  (how long until the server is up)
//   first-diag  didOpen (or proxy warmup) -> first publishDiagnostics
//               (cold analysis latency: how long before you see any errors)
//
// pyright additionally reports change->refresh: the time from a didChange that
// fixes the code to the empty re-publish. That is the number that governs the
// "stale errors after a fix" experience — diagnostics only refresh when the
// client sends didChange, and this is how long the refresh itself takes.
//
// Each metric is measured over PERF_ITERS (default 3) fresh spawns; the table
// reports median / min. Driven by tests/perf.sh. Node stdlib only, per repo
// convention.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { requireEnv, newWorkdir, sleep } = require('./lsp-test-utils.js');
const { LspClient, parseLspJson, wireLanguageIdFor } = require('./lsp-client.js');

const { ROOT_DIR, TMP_DIR, TESTS_DIR } = requireEnv();
const FIXTURES = path.join(TESTS_DIR, 'fixtures');
const ITERS = Math.max(1, parseInt(process.env.PERF_ITERS || '3', 10));

// One target per server. `publishes:false` servers (cue lsp v0.16 exposes the
// transport but no diagnostic provider) report ready only. `viaWarmup` targets
// (proxied regal) must NOT send didOpen — the proxy's warmup walk opens files
// on our behalf, and open-after-open is a spec violation Regal reacts badly to.
const TARGETS = [
  {
    plugin: 'bash-language-server',
    binary: 'bash-language-server',
    subdir: 'bash',
    includes: ['broken.sh'],
    file: 'broken.sh',
    publishes: true,
    timeout: 8000,
  },
  {
    plugin: 'pyright',
    binary: 'pyright-langserver',
    subdir: 'pyright',
    includes: ['broken.py', 'pyrightconfig.json'],
    file: 'broken.py',
    publishes: true,
    timeout: 15000,
    refresh: { fixedText: 'x: int = 5\nprint(x)\n' },
  },
  {
    plugin: 'vtsls',
    binary: 'vtsls',
    subdir: 'vtsls',
    includes: ['broken.ts', 'tsconfig.json'],
    file: 'broken.ts',
    publishes: true,
    timeout: 15000,
  },
  {
    plugin: 'regal-lsp',
    binary: 'regal',
    subdir: 'regal',
    includes: ['broken.rego', '.regal'],
    file: 'broken.rego',
    publishes: true,
    viaWarmup: true,
    timeout: 12000,
  },
  {
    plugin: 'cue-lsp',
    binary: 'cue',
    subdir: 'cue',
    includes: ['clean.cue', 'cue.mod'],
    file: 'clean.cue',
    publishes: false,
    timeout: 6000,
  },
];

function onPath(bin) {
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    try {
      fs.accessSync(path.join(d, bin), fs.constants.X_OK);
      return true;
    } catch {}
  }
  return false;
}

function prepWorkdir(tag, subdir, includes) {
  const dir = newWorkdir(TMP_DIR, tag);
  for (const name of includes) {
    fs.cpSync(path.join(FIXTURES, subdir, name), path.join(dir, name), { recursive: true });
  }
  return dir;
}

// One cold-spawn measurement for a target. Returns { ready, firstDiag, refresh }
// in ms; firstDiag/refresh are null when not applicable or not observed.
async function measureOnce(t, iter) {
  const dir = prepWorkdir(`perf-${t.plugin}-${iter}`, t.subdir, t.includes);
  const fileUri = pathToFileURL(path.join(dir, t.file)).href;
  const rootUri = pathToFileURL(dir).href;

  const pluginDir = path.join(ROOT_DIR, t.plugin);
  const parsed = parseLspJson(pluginDir);
  const client = new LspClient({
    command: parsed.command,
    args: parsed.args,
    cwd: dir,
    env: t.env || {},
  });

  const spawnAt = Date.now();
  await client.start();
  const out = { ready: null, firstDiag: null, refresh: null };
  try {
    // viaWarmup targets start opening files at the `initialized` notification
    // sent INSIDE initialize(), so their first-diag baseline must predate it —
    // a post-initialize baseline can trail the first publish and report
    // negative latency. (Their first-diag therefore includes the handshake.)
    const warmupBaseline = Date.now();
    await client.initialize({ rootUri });
    out.ready = Date.now() - spawnAt;

    if (t.publishes) {
      const openAt = t.viaWarmup ? warmupBaseline : Date.now();
      if (!t.viaWarmup) {
        const text = fs.readFileSync(path.join(dir, t.file), 'utf8');
        client.didOpen({ uri: fileUri, languageId: wireLanguageIdFor(parsed, t.file), text });
      }
      const pub = await client.waitForPublish({ uri: fileUri, timeout: t.timeout });
      out.firstDiag = pub ? pub.at - openAt : null;

      if (pub && t.refresh) {
        const baseSeq = client.publishSeq(fileUri);
        const changeAt = Date.now();
        client.didChange({ uri: fileUri, text: t.refresh.fixedText });
        const ref = await client.waitForPublish({
          uri: fileUri,
          afterSeq: baseSeq,
          timeout: t.timeout,
        });
        out.refresh = ref ? ref.at - changeAt : null;
      }
    } else {
      // No diagnostics to wait for; give the server the same analysis window so
      // "ready" reflects a settled server, then confirm it survived.
      await sleep(Math.min(1500, t.timeout));
      if (!client.isAlive()) throw new Error('server exited before the analysis window elapsed');
    }
  } finally {
    try {
      await client.shutdown();
    } catch {}
  }
  return out;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const cell = (xs) => (xs.length ? `${median(xs)} / ${Math.min(...xs)}` : '—');

async function main() {
  const rows = [];
  for (const t of TARGETS) {
    if (!onPath(t.binary)) {
      rows.push({ plugin: t.plugin, skipped: `missing: ${t.binary}` });
      continue;
    }
    process.stderr.write(`measuring ${t.plugin} (${ITERS}x)`);
    const ready = [],
      firstDiag = [],
      refresh = [];
    let err = null;
    for (let i = 0; i < ITERS; i++) {
      try {
        const r = await measureOnce(t, i);
        if (r.ready != null) ready.push(r.ready);
        if (r.firstDiag != null) firstDiag.push(r.firstDiag);
        if (r.refresh != null) refresh.push(r.refresh);
        process.stderr.write('.');
      } catch (e) {
        err = e?.message ? e.message : String(e);
        process.stderr.write('x');
      }
    }
    process.stderr.write('\n');
    rows.push({
      plugin: t.plugin,
      ready,
      firstDiag,
      refresh,
      note: t.publishes ? null : 'no publish',
      err,
    });
  }

  // Render.
  const W = Math.max(...TARGETS.map((t) => t.plugin.length), 6);
  const pad = (s) => String(s).padEnd(W);
  const col = (s) => String(s).padStart(18);
  console.log('');
  console.log(`LSP diagnostics latency  (median / min ms over ${ITERS} cold spawns)`);
  console.log('');
  console.log(`${pad('plugin')}${col('ready')}${col('first-diag')}${col('change→refresh')}`);
  console.log('-'.repeat(W + 18 * 3));
  for (const r of rows) {
    if (r.skipped) {
      console.log(`${pad(r.plugin)}${col('skipped')}   (${r.skipped})`);
      continue;
    }
    const diag = r.note ? r.note : cell(r.firstDiag);
    let line = `${pad(r.plugin)}${col(cell(r.ready))}${col(diag)}${col(r.refresh?.length ? cell(r.refresh) : '—')}`;
    if (r.err) line += `   ! ${r.err}`;
    console.log(line);
  }
  console.log('');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e?.stack ? e.stack : String(e));
    process.exit(1);
  });
