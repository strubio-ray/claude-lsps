#!/usr/bin/env node
// Usage: node coverage-check.js [--threshold=80]

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const ROOT_DIR = process.env.ROOT_DIR;
const COV_DIR = process.env.NODE_V8_COVERAGE;
if (!(ROOT_DIR && COV_DIR)) {
  console.error('ROOT_DIR and NODE_V8_COVERAGE must be set');
  process.exit(2);
}

// Glob every plugin directory for lsp-proxy.js so a new proxy added later
// automatically falls under the coverage gate instead of silently shipping
// at 0%.
const TARGETS = fs
  .readdirSync(ROOT_DIR)
  .map((d) => path.join(ROOT_DIR, d, 'lsp-proxy.js'))
  .filter((p) => fs.existsSync(p))
  // Realpath both sides so macOS' /private/var <-> /var mapping in V8 URLs
  // doesn't cause us to miss a file's coverage entries.
  .map((p) => fs.realpathSync(p));

let threshold = 80;
for (const arg of process.argv.slice(2)) {
  const m = /^--threshold=(\d+(?:\.\d+)?)$/.exec(arg);
  if (m) threshold = parseFloat(m[1]);
}

function loadCoverageFiles() {
  if (!fs.existsSync(COV_DIR)) return [];
  return fs
    .readdirSync(COV_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const full = path.join(COV_DIR, f);
      try {
        return JSON.parse(fs.readFileSync(full, 'utf8'));
      } catch (err) {
        // A corrupt coverage file would otherwise silently lower the count
        // and could make a 79% gate pass spuriously. Log loudly.
        console.error(`coverage-check: failed to parse ${full}: ${err.message}`);
        return null;
      }
    })
    .filter(Boolean);
}

function urlToPath(url) {
  const p = url.startsWith('file://') ? fileURLToPath(url) : url;
  // Normalize via realpath so /private/var-vs-/var on macOS doesn't cause a
  // miss against TARGETS (which are already realpath-ed above).
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

// V8 coverage is range-based. Per-byte state: 0 = no instrumentation, 1 =
// covered, 2 = uncovered. Within a single coverage entry inner ranges must
// override their enclosing range (an outer function called once may contain
// inner branches that never ran). Across entries from different subprocess
// runs, covered always wins.
function computeCoverage(sourcePath, entries) {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const len = source.length;
  const state = new Uint8Array(len);

  for (const entry of entries) {
    const local = new Uint8Array(len);
    for (const fn of entry.functions || []) {
      // Sort outer→inner so inner ranges override regardless of V8's
      // emission order (which isn't a public contract).
      const sorted = fn.ranges.slice().sort((a, b) => {
        if (a.startOffset !== b.startOffset) return a.startOffset - b.startOffset;
        return b.endOffset - a.endOffset;
      });
      for (const r of sorted) {
        const mark = r.count > 0 ? 1 : 2;
        const start = Math.max(0, r.startOffset | 0);
        const end = Math.min(len, r.endOffset | 0);
        for (let i = start; i < end; i++) local[i] = mark;
      }
    }
    for (let i = 0; i < len; i++) {
      if (local[i] === 1) state[i] = 1;
      else if (local[i] === 2 && state[i] !== 1) state[i] = 2;
    }
  }

  // A line counts as covered if it has any covered byte; uncovered if it has
  // uncovered bytes but no covered byte; otherwise it's outside the
  // denominator (blank lines, comments, code outside any function body).
  let covered = 0,
    uncovered = 0,
    total = 0;
  const uncoveredLineNums = [];
  let line = 0;
  let i = 0;
  while (i <= len) {
    let end = i;
    while (end < len && source[end] !== '\n') end++;
    let hasCovered = false,
      hasUncovered = false;
    for (let j = i; j < end; j++) {
      if (state[j] === 1) hasCovered = true;
      else if (state[j] === 2) hasUncovered = true;
    }
    total++;
    line++;
    if (hasCovered) covered++;
    else if (hasUncovered) {
      uncovered++;
      uncoveredLineNums.push(line);
    }
    i = end + 1;
  }
  const denom = covered + uncovered;
  return {
    sourceLines: total,
    coveredLines: covered,
    uncoveredLines: uncovered,
    uncoveredLineNums,
    percent: denom === 0 ? 100 : (covered / denom) * 100,
  };
}

function main() {
  const all = loadCoverageFiles();
  if (all.length === 0) {
    console.error(`no coverage files in ${COV_DIR}`);
    process.exit(1);
  }

  const targetSet = new Set(TARGETS);
  const byFile = new Map();
  for (const cov of all) {
    for (const result of cov.result || []) {
      const p = urlToPath(result.url || '');
      if (!targetSet.has(p)) continue;
      if (!byFile.has(p)) byFile.set(p, []);
      byFile.get(p).push(result);
    }
  }

  // The unified proxy ships as byte-identical copies in every plugin dir
  // (enforced by consistency/proxy-copies-identical). Coverage is a property
  // of the CODE, not the deploy path, so group targets by content hash and
  // gate each group on the union of its copies' coverage — the wire suite
  // spreads scenarios across copies instead of repeating every scenario six
  // times. A copy that drifts breaks the identity test before it could dodge
  // the gate here.
  const groups = new Map(); // hash -> [target, ...]
  for (const target of TARGETS) {
    const h = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
    if (!groups.has(h)) groups.set(h, []);
    groups.get(h).push(target);
  }

  let pass = true;
  const lines = [];
  for (const members of groups.values()) {
    const entries = members.flatMap((t) => byFile.get(t) || []);
    const label =
      members.length === 1
        ? path.relative(ROOT_DIR, members[0])
        : `${members.length} identical copies (${members.map((t) => path.relative(ROOT_DIR, t)).join(', ')})`;
    if (entries.length === 0) {
      lines.push(`  ${label}: NO DATA`);
      pass = false;
      continue;
    }
    const { coveredLines, uncoveredLines, percent, uncoveredLineNums } = computeCoverage(
      members[0],
      entries,
    );
    const status = percent >= threshold ? 'ok' : 'FAIL';
    lines.push(
      `  ${label}: ${percent.toFixed(1)}% ` +
        `(${coveredLines} covered / ${coveredLines + uncoveredLines} executable) [${status}]`,
    );
    if (percent < threshold) {
      pass = false;
      const sample = uncoveredLineNums.slice(0, 15).join(', ');
      const more =
        uncoveredLineNums.length > 15 ? ` ...(+${uncoveredLineNums.length - 15} more)` : '';
      lines.push(`      uncovered lines: ${sample}${more}`);
    }
  }

  console.log(`coverage gate (threshold ${threshold}%):`);
  for (const l of lines) console.log(l);

  if (!pass) {
    console.error(`coverage below threshold ${threshold}%`);
    process.exit(1);
  }
}

main();
