#!/usr/bin/env node
// Self-verifying A/B demonstration of the pyright sync proxy.
//
//   CONTROL   direct pyright: open a broken file, fix it ON DISK without sending
//             didChange -> pyright keeps reporting the stale error (the bug).
//   TREATMENT pyright behind lsp-proxy.js: same disk-only fix -> the proxy
//             injects a didChange and pyright re-publishes an empty set (fixed).
//
// The treatment then runs a HYBRID phase modeled on real Claude Code behavior
// (validated by ../lsp-wiretap/FINDINGS.md — the client didChanges its own
// Edit-tool writes but never syncs Bash/out-of-band edits):
//   3. the CLIENT edits: writes broken content to disk AND sends its own
//      didChange (like the Edit tool) -> error appears;
//   4. an out-of-band disk-only fix follows (like `sed`) -> the proxy must
//      STILL inject (no permanent back-off) and the error must clear.
//
// Exits non-zero if any expectation fails, so it doubles as a regression
// check. Requires pyright-langserver on PATH. Run: node demo.js
//
// Node stdlib only; reuses the repo's test LspClient for the wire handshake.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { LspClient } = require('../../tests/helpers/lsp-client.js');

const PROXY_JS = path.join(__dirname, 'lsp-proxy.js');
const PROXY_JSON = path.join(__dirname, 'proxy.json');
const BROKEN = 'x: int = "not an int"\nprint(x)\n';
const FIXED = 'x: int = 5\nprint(x)\n';
const PYRIGHTCONFIG = JSON.stringify(
  { include: ['.'], pythonVersion: '3.11', reportGeneralTypeIssues: 'error' },
  null,
  2,
);

function makeWorkdir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyright-sync-demo-'));
  fs.writeFileSync(path.join(dir, 'broken.py'), BROKEN);
  fs.writeFileSync(path.join(dir, 'pyrightconfig.json'), PYRIGHTCONFIG);
  return dir;
}

// Open broken.py, wait for the error, then rewrite the file to the fixed
// content ON DISK only (no didChange from the client) — exactly what a Bash
// `sed`/git/formatter edit looks like. `command`/`args` select direct pyright
// vs. the proxy. When `hybrid` is set, continue into phases 3–4 (client-driven
// didChange, then another disk-only edit).
async function run({ label, command, args, hybrid = false }) {
  const dir = makeWorkdir();
  const filePath = path.join(dir, 'broken.py');
  const fileUri = pathToFileURL(filePath).href;
  const rootUri = pathToFileURL(dir).href;
  const client = new LspClient({ command, args, cwd: dir });

  const result = {
    label,
    opened: null,
    afterDiskFix: null,
    refreshMs: null,
    afterClientEdit: null,
    afterHybridFix: null,
  };
  await client.start();
  try {
    await client.initialize({ rootUri });

    client.didOpen({ uri: fileUri, languageId: 'python', text: BROKEN });
    const errDiags = await client.waitForDiagnostics({
      uri: fileUri,
      mode: 'push',
      timeout: 15000,
    });
    result.opened = errDiags.map((d) => d.message);
    if (errDiags.length === 0) throw new Error('expected an error on open, got none');

    // Phase 2 — the fix: disk write, NO didChange.
    let baseSeq = client.publishSeq(fileUri);
    const changeAt = Date.now();
    fs.writeFileSync(filePath, FIXED);

    // Wait for a refresh publish; if none comes within the window, pyright
    // stayed stale (the control's expected outcome).
    const refreshed = await client.waitForPublish({
      uri: fileUri,
      afterSeq: baseSeq,
      timeout: 4000,
    });
    if (refreshed) {
      result.afterDiskFix = refreshed.diagnostics.map((d) => d.message);
      result.refreshMs = refreshed.at - changeAt;
    } else {
      result.afterDiskFix = null; // no new publish — diagnostics frozen at the error
    }

    if (hybrid) {
      // Phase 3 — CLIENT edit, Claude Code style: write disk, then didChange.
      baseSeq = client.publishSeq(fileUri);
      fs.writeFileSync(filePath, BROKEN);
      client.didChange({ uri: fileUri, text: BROKEN });
      const clientPub = await client.waitForPublish({
        uri: fileUri,
        afterSeq: baseSeq,
        timeout: 8000,
      });
      result.afterClientEdit = clientPub ? clientPub.diagnostics.map((d) => d.message) : null;

      // Phase 4 — out-of-band disk-only fix AFTER the client has didChanged.
      // A back-off design goes permanently deaf here; reconciliation must not.
      baseSeq = client.publishSeq(fileUri);
      fs.writeFileSync(filePath, FIXED);
      const hybridPub = await client.waitForPublish({
        uri: fileUri,
        afterSeq: baseSeq,
        timeout: 4000,
      });
      result.afterHybridFix = hybridPub ? hybridPub.diagnostics.map((d) => d.message) : null;
    }
  } finally {
    try {
      await client.shutdown();
    } catch {}
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  return result;
}

async function main() {
  const control = await run({
    label: 'CONTROL   (direct pyright)',
    command: 'pyright-langserver',
    args: ['--stdio'],
  });
  const treatment = await run({
    label: 'TREATMENT (sync proxy)',
    command: 'node',
    args: [PROXY_JS, '--config', PROXY_JSON],
    hybrid: true,
  });

  const line = (r) => {
    const err = r.opened.length;
    if (r.afterDiskFix === null)
      return `${r.label}: opened→${err} error(s); after disk fix → NO re-publish (stale)`;
    const n = r.afterDiskFix.length;
    return (
      `${r.label}: opened→${err} error(s); after disk fix → ${n} diag(s)` +
      (n === 0 ? ` CLEARED in ${r.refreshMs}ms` : ' (still present)')
    );
  };

  console.log('');
  console.log(line(control));
  console.log(line(treatment));
  console.log('');

  const h = treatment;
  console.log(
    `HYBRID    (sync proxy): client didChange → ` +
      `${h.afterClientEdit === null ? 'NO publish' : `${h.afterClientEdit.length} diag(s)`}; ` +
      `then disk-only fix → ` +
      `${h.afterHybridFix === null ? 'NO re-publish (proxy went deaf)' : `${h.afterHybridFix.length} diag(s)`}`,
  );
  console.log('');

  // Expectations: control stays stale; treatment clears; hybrid phase shows the
  // client's own edit landing AND the subsequent disk-only fix still syncing.
  const controlStale = control.afterDiskFix === null;
  const treatmentFixed =
    Array.isArray(treatment.afterDiskFix) && treatment.afterDiskFix.length === 0;
  const clientEditLanded = Array.isArray(h.afterClientEdit) && h.afterClientEdit.length >= 1;
  const hybridFixed = Array.isArray(h.afterHybridFix) && h.afterHybridFix.length === 0;

  const problems = [];
  if (!controlStale)
    problems.push('control unexpectedly refreshed (pyright watched disk on its own?)');
  if (!treatmentFixed) problems.push('treatment did NOT clear the error via the proxy');
  if (!clientEditLanded)
    problems.push('client-driven didChange did not produce the expected error');
  if (!hybridFixed)
    problems.push('disk-only fix AFTER a client didChange did not sync (back-off regression)');

  if (problems.length) {
    console.log('DEMO FAILED:');
    for (const p of problems) console.log(`  - ${p}`);
    process.exit(1);
  }
  console.log(
    'DEMO PASSED — disk-only edits sync through the proxy, including after client didChanges.',
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e?.stack ? e.stack : String(e));
  process.exit(1);
});
