#!/usr/bin/env bash
# scripts/common/cloud-setup.sh — TEMPLATE-OWNED core of the Claude Code on
# the web "Setup script" for claude-lsps's cloud environment.
#
# OWNERSHIP (shim/common/repo-local layout): this file is rendered by the
# rubio-standards template on every `copier update` — do NOT edit it in a
# consumer repo (edits are template drift). The execution chain is:
#   UI wrapper (pasted in the cloud env) → scripts/cloud-setup-shim.sh
#   (frozen consumer entry) → THIS file (all logic) →
#   scripts/repo-local/cloud-setup.sh (optional, repo-owned additions).
# Repo-specific setup belongs in scripts/repo-local/cloud-setup.sh, which this
# core runs (abort-proof) after its own work.
#
# This file holds the real setup logic — do NOT paste this whole file into the
# cloud "Setup script" (web UI) field. Paste ONLY the thin wrapper between the
# two "8<" COPY markers below: it stays version-controlled and PR-reviewed here
# instead of pasted-and-forgotten, and it LOCATES the shim at runtime rather
# than assuming a path (the cloud Setup script's working directory is NOT the
# repo root, so a bare `bash scripts/cloud-setup-shim.sh` fails with exit 127).
# The block below is an inert heredoc — read and discarded by `:`, never
# executed — so the wrapper is raw, ready-to-paste text: NO comment-stripping
# needed, just copy everything between the two marker lines.
: <<'CLOUD_SETUP_WEB_WRAPPER'

# ===== 8< ===== COPY FROM THE NEXT LINE INTO THE WEB "Setup script" FIELD =====
#!/usr/bin/env bash
# Repo-agnostic: this EXACT block works in every repo's cloud environment —
# nothing below is project-specific, so one shared block fits the whole fleet.
# Bump CACHE_EPOCH (e.g. 1 -> 2) and re-save this field to force an env-cache rebuild.
CACHE_EPOCH=1
export CACHE_EPOCH
# PRIVATE GitHub dependencies: export the org's shared read-only fine-grained
# PAT here (one org-wide token — the block stays fleet-uniform). The
# "Environment variables" field reaches SESSIONS only, never this setup run
# (proven 2026-07: the build log printed "auth tokens present at build: NONE"
# with GH_PAT set in that field), so this line is the only way the snapshot
# build can clone private marketplace and Go-module repos. Per the docs this
# field has the SAME visibility as the env-vars field, so this is not a
# security downgrade.
# Re-saving after editing this field rebuilds the cache automatically.
export GH_PAT='github_pat_REPLACE_ME'
for d in "${CLAUDE_PROJECT_DIR:-}" "$PWD"; do
  for sub in scripts Scripts; do
    [ -n "$d" ] && [ -f "$d/$sub/cloud-setup-shim.sh" ] &&
      { cd "$d" && exec bash "$sub/cloud-setup-shim.sh"; }
  done
done
s="$(find /home /root /workspace -maxdepth 5 -iname cloud-setup-shim.sh -ipath '*/scripts/*' 2>/dev/null | head -n1)"
[ -n "$s" ] && { cd "$(dirname "$s")/.." && exec bash "$s"; }
echo "cloud-setup-shim.sh not found on this branch; SessionStart hook will bootstrap" >&2
# ===== 8< ===== COPY UP TO THE PREVIOUS LINE =====

CLOUD_SETUP_WEB_WRAPPER
#
# Forcing a rebuild on demand: the snapshot is rebuilt ONLY when the UI
# Setup-script TEXT changes, when the environment's ALLOWED NETWORK HOSTS
# change, or at the ~7-day expiry — it CANNOT see edits to THIS file, and
# env-var changes do NOT count. So after this script changes (usually via a
# copier-sync PR), bump CACHE_EPOCH in the UI wrapper and re-save — or simply
# wait out the ~7-day expiry. The SessionStart hook core
# (scripts/common/session-start-claude.sh) re-hashes the checked-out
# shim + this core against a fingerprint baked into the snapshot (written at
# the bottom of this file to
# ${XDG_CACHE_HOME:-$HOME/.cache}/$(basename "$repo_root")/cloud-setup.built —
# see the drift-fingerprint note there) and surfaces a NOTE when a bump is due.
# The hook reads that SAME runtime-basename path, so the two agree byte-for-byte.
# https://code.claude.com/docs/en/claude-code-on-the-web#environment-caching
#
# Execution model (cloud only): runs as root on Ubuntu, BEFORE Claude Code
# launches, and ONLY when no cached environment snapshot exists. Its filesystem
# output is snapshotted and reused, so everything here is paid once per cache
# build (~7 days), not per session. Keep total runtime under ~5 minutes so the
# cache can build; independent work runs in parallel below.
#
# Division of labour:
#   * Only root/apt installs, private-dependency git credential helpers, and
#     snapshot-cacheable warming live here.
#   * Everything portable (the pinned mise toolchain) lives in
#     scripts/common/session-start-claude.sh so it runs in BOTH local and
#     cloud sessions. This script just calls that hook core so the toolchain
#     lands in the snapshot; the per-session SessionStart hook then
#     fast-paths to a no-op.
#
# PRIVATE GitHub auth (REQUIRED for private org dependencies):
#   Public org marketplaces (e.g. claude-lsps) install in cloud with NO token.
#   PRIVATE in-org bundle marketplaces declared in .claude/settings.json —
#   including rubio-standards@rubio now that standards is private — and private
#   Go module repos named by go.mod need GH_PAT, a fine-grained PAT
#   (Rubio-Enterprises, Contents:Read on the private marketplace and Go-module
#   repos) EXPORTED IN THE "Setup script" WRAPPER above, NOT in the
#   "Environment variables" field: env vars are injected into SESSIONS only,
#   never into setup/snapshot builds — proven 2026-07 when the build diagnostic
#   printed "auth tokens present at build: NONE" with GH_PAT set in that field
#   — and both marketplace pre-seed clones and Go module downloads run at BUILD
#   time. Per the docs both fields share the same visibility ("Both environment
#   variables and setup scripts are stored in the environment configuration,
#   visible to anyone who can edit that environment"), so the wrapper placement
#   is not a security downgrade. ONE shared, narrowly-scoped, read-only token
#   reused across ALL cloud environments is sufficient. The per-repository
#   credential helpers registered below read it at CLONE time and are scoped so
#   the read-only token authenticates only those private dependency clones,
#   never the working repo. Do NOT put GH_PAT or GH_TOKEN in the env-vars field:
#   GH_PAT there never reaches builds, and a user-set GH_TOKEN CLOBBERS the
#   platform's session-injected working-repo-scoped token (observed live).
set -uo pipefail

# Operate from the repo root regardless of the caller's cwd (the UI Setup script
# does NOT start at the repo root). Resolve from this file's own location —
# TWO levels up: this core lives at scripts/common/.
src="${BASH_SOURCE[0]:-$0}"
unset CDPATH
repo_root="$(cd -- "$(dirname -- "$src")/../.." 2>/dev/null && pwd)"
if [ -z "$repo_root" ] || ! cd -- "$repo_root"; then
  echo "cloud-setup: cannot resolve repo root from $src; skipping" >&2
  exit 0
fi

# --- Smoke mode (CI parity check; CLOUD_SETUP_SMOKE) -------------------------
# This script is NON-FATAL BY CONTRACT: a Setup script that exits non-zero
# blocks the cloud session from starting, so every step below swallows its own
# failure and the script always ends in `exit 0`. That contract also makes the
# script UNTESTABLE by exit code — the bare-`command -v` node fallback failed on
# EVERY snapshot build of EVERY has_embedded_web consumer and still exited 0,
# visible only as one line in a build log nobody reads.
#
# CLOUD_SETUP_SMOKE inverts the contract FOR CI ONLY. Every step still runs to
# completion (no `set -e`, no early abort — a smoke run must report ALL
# failures, not just the first); failures are recorded and re-raised as a
# non-zero exit at the very end. Two levels:
#
#   CLOUD_SETUP_SMOKE=warm  cache warm + repo-local only. The template render
#                           canary's per-shape check: a freshly-rendered fixture
#                           has no dependencies, so bootstrapping its toolchain
#                           would be one mise install per matrix row for no
#                           signal. Asserts the script parses and its control
#                           flow runs clean on Linux.
#   CLOUD_SETUP_SMOKE=1     the above PLUS the pinned toolchain bootstrap. The
#                           consumer-side job, run against the repo's real
#                           manifests — without the toolchain, `command -v uv`
#                           is false and every warm step no-ops, making the
#                           smoke vacuous.
#
# Skipped at BOTH levels (cloud-only, and their absence is not a repo defect):
# apt, the marketplace credential helper + pre-seed, plugin-cache
# materialization, workflow seeding, and the snapshot drift fingerprint. They
# need root and/or the `claude` CLI. What smoke covers is where a repo actually
# breaks: the toolchain bootstrap, the archetype cache warm, and
# scripts/repo-local/cloud-setup.sh. The private-Go helper below is the narrow
# exception: credentialed smoke can exercise the real module warm without
# enabling marketplace setup.
#
# With CLOUD_SETUP_SMOKE unset the cloud path is untouched, down to the bytes:
# __warn emits exactly the `cloud-setup: <x> failed (non-fatal)` line it
# replaced, and __smoke_check_failed emits nothing at all.
__smoke="${CLOUD_SETUP_SMOKE:-}"
__smoke_failures=""
# Non-fatal step failure. Cloud-mode output is byte-identical to the inline
# `echo` lines this replaced, so a snapshot log reads exactly as it always has.
__warn() {
  echo "cloud-setup: $1 failed (non-fatal)" >&2
  if [ -n "$__smoke" ]; then
    __smoke_failures="${__smoke_failures}${__smoke_failures:+; }$1"
  fi
  return 0
}
# Smoke-only assertion failure: silent and inert in cloud mode, and inert at the
# `warm` level too (which deliberately runs without a toolchain, so a missing
# tool there is expected rather than a defect).
# Defined on every render shape (the skeleton is uniform), but every call site
# is archetype-conditional (go/rust/python-root warms), so a shape rendering
# none of them — swift-only, ts/js-only, python-nested — defines it uncalled.
# shellcheck disable=SC2317,SC2329  # call sites are render-shape-conditional; on some shapes none renders
__smoke_check_failed() {
  if [ -z "$__smoke" ] || [ "$__smoke" = "warm" ]; then
    return 0
  fi
  echo "cloud-setup: SMOKE CHECK FAILED — $1" >&2
  __smoke_failures="${__smoke_failures}${__smoke_failures:+; }$1"
  return 0
}

if [ -n "$__smoke" ]; then
  echo "cloud-setup: SMOKE ($__smoke) — claude-lsps on $(uname -s)/$(uname -m); cloud-only sections skipped" >&2
else
  echo "cloud-setup: building claude-lsps environment cache (epoch ${CACHE_EPOCH:-unset})" >&2
fi

# --- Marketplace SSH->HTTPS rewrite (early; helper registered after apt) -----
# Rewrite git@github.com: SSH-form marketplace sources to HTTPS so the runtime
# credential helper (registered AFTER the apt step below, once `jq` is installed
# to parse the carrier and scope the helper per-repo) can authenticate them.
# Idempotent; non-fatal. Skipped in smoke mode: a CI runner's global git config
# is shared with the checkout steps, and no marketplace clone happens there.
[ -n "$__smoke" ] ||
  git config --global url."https://github.com/".insteadOf "git@github.com:" || true

# apt (root-only — cannot live in the portable hook), GUARDED: jq is the only
# apt dependency — it parses the committed .claude/settings.json so the
# credential helper and the marketplace pre-seed can be scoped per-repo — and
# the cloud base image has shipped it for a while now (snapshot logs showed
# the old "gh/jq install failed" line followed by a successfully SCOPED
# helper, which requires jq). So apt here is a fallback for a base-image
# regression, not a routine step: most rebuilds skip the slowest, flakiest
# network dependency entirely. gh is dropped — it never installed
# successfully in the cloud image, nothing in this setup uses it, and cloud
# sessions use the built-in GitHub tools. When the install does run it is
# parallel with the toolchain bootstrap and non-fatal (a Setup script that
# exits non-zero blocks the session from starting): on failure the credential
# helper degrades to its global fallback and the pre-seed no-ops.
apt_pid=""
if [ -z "$__smoke" ] && ! command -v jq >/dev/null 2>&1; then
  (
    export DEBIAN_FRONTEND=noninteractive
    apt-get update && apt-get install -y --no-install-recommends jq
  ) &
  apt_pid=$!
fi

# Same bootstrap the SessionStart hook runs. Installing it here bakes the pinned
# mise toolchain into the snapshot. CLAUDE_CODE_REMOTE=true forces the hook's
# cloud branch (the var isn't reliably exported this early). GH_TOKEN ->
# GITHUB_TOKEN lets mise's aqua/github backends fetch release metadata without
# the unauthenticated GitHub rate limit (the hook also bridges this internally;
# belt-and-suspenders). GH_PAT is the LAST fallback so environments only ever
# need to provide GH_PAT (exported in the Setup-script wrapper — see the
# header notes): at snapshot time neither the session-injected GH_TOKEN nor
# the env-vars field exists, and any valid token — the read-only marketplace
# PAT included — lifts the anonymous api.github.com rate limit.
# CLOUD_SETUP_BUILD=1 tells the hook's cloud plugin health check that this is
# the snapshot build, not a live session: it must skip here because the
# marketplace pre-seed section below has not run yet at this point.
# Guarded so a greenfield render with no hook yet no-ops.
#
# Smoke mode runs this at the `1` level and skips it at `warm`. Note its exit
# code proves nothing either way: the hook is abort-proof by contract (§6.1 —
# every step `|| true`, always `exit 0`), so a failed mise install surfaces only
# as stderr chatter. What the smoke actually gets from running it is the PATH it
# leaves behind — the warm steps below need the toolchain it installs, and the
# `__smoke_check_failed` guards there report the tools it failed to provide.
if [ -f scripts/common/session-start-claude.sh ] && [ "$__smoke" != "warm" ]; then
  CLAUDE_CODE_REMOTE=true CLOUD_SETUP_BUILD=1 GITHUB_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-${GH_PAT:-}}}" \
    bash scripts/common/session-start-claude.sh || true
fi

if [ -n "$apt_pid" ]; then
  wait "$apt_pid" || echo "cloud-setup: jq install failed (non-fatal; credential helper falls back to global; marketplace pre-seed skipped)" >&2
fi

# --- Private-marketplace git credential helper (RUNTIME, repo-scoped) --------
# Register a runtime credential helper for the PRIVATE in-org marketplace repos
# ONLY, so the marketplace pre-seed's clones (next section) authenticate with
# the read-only GH_PAT while the WORKING repo keeps using its own
# session-injected token. The repos are derived
# from the committed carrier's extraKnownMarketplaces (github sources); BOTH the
# bare and ".git" clone-URL forms are registered because git credential
# URL-matching is exact, not suffix-tolerant. Scoping is per-REPO — never a
# global helper, never a github.com/<org> prefix (an org prefix over-matches
# EVERY repo in the org, including the working repo, and would hand it the
# read-only token, breaking working-repo writes). Net effect: ONE shared,
# narrowly-scoped, read-only GH_PAT can never interfere with working-repo auth.
# Token precedence GH_PAT -> GH_TOKEN -> GITHUB_TOKEN, resolved at CLONE time.
# Do NOT use `gh auth setup-git` (errors "not logged into any GitHub hosts").
# Degrades to a single global helper if jq is unavailable or the carrier
# declares no github marketplaces, so a private clone never silently loses auth.
# Idempotent (git config --global overwrites); non-fatal.
# shellcheck disable=SC2016  # ${GH_PAT:-...} must stay literal and expand at clone time, not now
__mkt_helper='!f(){ echo username=x-access-token; echo "password=${GH_PAT:-${GH_TOKEN:-${GITHUB_TOKEN:-}}}"; };f'
# ONE parse of the carrier feeds BOTH the credential-helper scoping here and
# the marketplace pre-seed section below: "<name>\t<owner/repo>" per github
# marketplace. (The pre-seed needs the marketplace NAME — it is the on-disk
# clone dir and the registry key — not just the repo, so extract pairs first,
# then derive the unique repo list for the helper loop.)
# Smoke mode leaves both empty, which is what switches the whole marketplace
# surface off: the helper loop below, the pre-seed section, and (via the plugin
# cache it would have populated) workflow seeding all key on these being set.
__mkt_pairs=""
__mkt_repos=""
if [ -z "$__smoke" ] && command -v jq >/dev/null 2>&1 && [ -f .claude/settings.json ]; then
  __mkt_pairs="$(jq -r '
    (.extraKnownMarketplaces // {})
    | to_entries[]
    | select(.value.source | type == "object" and .source == "github" and (.repo | type == "string"))
    | "\(.key)\t\(.value.source.repo)"
  ' .claude/settings.json 2>/dev/null)"
  __mkt_repos="$(printf '%s\n' "$__mkt_pairs" | cut -f2 | sort -u)"
fi
if [ -n "$__mkt_repos" ]; then
  printf '%s\n' "$__mkt_repos" | while IFS= read -r __repo; do
    [ -z "$__repo" ] && continue
    git config --global "credential.https://github.com/${__repo}.helper" "$__mkt_helper" || true
    git config --global "credential.https://github.com/${__repo}.git.helper" "$__mkt_helper" || true
  done
  echo "cloud-setup: scoped marketplace credential helper to: $(printf '%s' "$__mkt_repos" | tr '\n' ' ')" >&2
elif [ -z "$__smoke" ]; then
  # Degraded path: no jq or no github marketplaces in the carrier. Use a single
  # global helper so a private clone is never left unauthenticated. A read-only
  # GH_PAT here could shadow the working-repo token for git WRITES — acceptable
  # only as the fallback when per-repo scoping is impossible.
  git config --global credential.helper "$__mkt_helper" || true
  echo "cloud-setup: global marketplace credential helper (jq/carrier unavailable; unscoped fallback)" >&2
fi

# --- Private Go-module git credential helper (RUNTIME, repo-scoped) ----------
# Keep org-owned modules off the public proxy and checksum database. Git still
# needs credentials for their source repositories, so derive each repo from
# go.mod rather than granting a github.com/Rubio-Enterprises prefix that would
# also shadow the working repo's write token. Only replace TARGETS count:
# replacing an org module with a local or public target needs no private clone.
# require accepts both its block and single-line forms. A module may name a
# package below the repository root, so scope to the first path segment after
# the org. Register both bare and ".git" URLs for the same exact-match reason as
# the marketplace loop above.
export GOPRIVATE='github.com/Rubio-Enterprises/*'
__go_repos=""
# Marketplace setup stays off in smoke mode. This helper is different: the
# credentialed smoke exports a per-run App token as GH_PAT so a real build can
# be proven. Register there iff any supported token is present; an
# uncredentialed smoke must not touch the runner's global git config.
if [ -f go.mod ] &&
  { [ -z "$__smoke" ] || [ -n "${GH_PAT:-${GH_TOKEN:-${GITHUB_TOKEN:-}}}" ]; }; then
  if ! __go_repos="$(
    awk '
      function emit(module, relative, parts) {
        if (module !~ /^github[.]com\/Rubio-Enterprises\/[^\/[:space:]]+/) {
          return
        }
        relative = substr(module, length("github.com/Rubio-Enterprises/") + 1)
        split(relative, parts, "/")
        print "Rubio-Enterprises/" parts[1]
      }
      function emit_replace_target(line, fields) {
        if (line !~ /=>/) {
          return
        }
        sub(/^.*=>[[:space:]]*/, "", line)
        split(line, fields, /[[:space:]]+/)
        emit(fields[1])
      }
      {
        line = $0
        sub(/[[:space:]]*\/\/.*/, "", line)
        sub(/^[[:space:]]+/, "", line)
        sub(/[[:space:]]+$/, "", line)
        if (line == "") {
          next
        }
        if (require_block) {
          if (line == ")") {
            require_block = 0
            next
          }
          split(line, fields, /[[:space:]]+/)
          emit(fields[1])
          next
        }
        if (replace_block) {
          if (line == ")") {
            replace_block = 0
            next
          }
          emit_replace_target(line)
          next
        }
        if (line ~ /^require[[:space:]]+/) {
          sub(/^require[[:space:]]+/, "", line)
          if (line == "(") {
            require_block = 1
          } else {
            split(line, fields, /[[:space:]]+/)
            emit(fields[1])
          }
          next
        }
        if (line ~ /^replace[[:space:]]+/) {
          sub(/^replace[[:space:]]+/, "", line)
          if (line == "(") {
            replace_block = 1
          } else {
            emit_replace_target(line)
          }
        }
      }
    ' go.mod | sort -u
  )"; then
    __go_repos=""
    __warn "private Go module discovery"
  fi
fi
if [ -n "$__go_repos" ]; then
  __go_scope_failed=""
  while IFS= read -r __repo; do
    [ -z "$__repo" ] && continue
    git config --global "credential.https://github.com/${__repo}.helper" "$__mkt_helper" ||
      __go_scope_failed=1
    git config --global "credential.https://github.com/${__repo}.git.helper" "$__mkt_helper" ||
      __go_scope_failed=1
  done <<<"$__go_repos"
  if [ -n "$__go_scope_failed" ]; then
    __warn "private Go module credential helper registration"
  else
    echo "cloud-setup: scoped private Go module credential helper to: $(printf '%s' "$__go_repos" | tr '\n' ' ')" >&2
  fi
fi

# --- Marketplace pre-seed (WORKAROUND: cloud skips native marketplace sync) --
# Claude Code on the web now launches sessions with SKIP_PLUGIN_MARKETPLACE=true
# in the platform startup context (observed 2026-07 in /tmp/env-manager.log
# "startup_context_env_var_keys"). With that flag set, Claude Code never syncs
# the carrier's extraKnownMarketplaces, so at startup EVERY enabledPlugins
# entry is dropped as "orphaned ... marketplace not registered" and no org
# plugin loads. Setting SKIP_PLUGIN_MARKETPLACE=false in the environment's
# env-vars field does NOT win over the startup context. Workaround: materialize
# at SNAPSHOT time exactly the on-disk state the native sync would have
# produced — one clone per marketplace, its registry entry, AND an installed
# cache copy of every enabled plugin (all three layers are required) — so
# startup plugin resolution finds everything already in place.
#   * Mirrors Claude Code's ~/.claude/plugins layout as of 2026-07
#     (known_marketplaces.json entry = {source, installLocation, lastUpdated});
#     an internals change can break it. REMOVE once a fresh cloud session loads
#     plugins with no pre-seed (or SKIP_PLUGIN_MARKETPLACE is gone/false).
#   * Clones run with GIT_CONFIG_GLOBAL=/dev/null plus the SAME inline runtime
#     helper as above: that makes them independent of global insteadOf
#     rewrites (the in-session git proxy rewrites github.com URLs; snapshot
#     builds differ), and since git only invokes the helper on a 401, public
#     marketplaces still clone tokenless while private ones use GH_PAT —
#     which reaches this build ONLY via the Setup-script wrapper export (see
#     the header notes: the env-vars field is sessions-only).
#   * Freshness: clones refresh only when this snapshot rebuilds (CACHE_EPOCH
#     bump or ~7-day expiry). Marketplace staleness is bounded by that; bump
#     the epoch to pick up new plugin versions early.
#   * Non-fatal per marketplace; failures are named with their stage so the
#     operator can tell a missing GH_PAT from a network-policy block.
if [ -n "$__mkt_pairs" ]; then
  __mkt_root="$HOME/.claude/plugins/marketplaces"
  __mkt_reg="$HOME/.claude/plugins/known_marketplaces.json"
  __mkt_now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  __mkt_ok=""
  __mkt_bad=""
  mkdir -p "$__mkt_root" 2>/dev/null || true
  # Which token vars actually reach the BUILD environment (names only, never
  # values): settles instantly whether GH_PAT made it into this build or the
  # token itself is being rejected.
  __mkt_tok=""
  [ -n "${GH_PAT:-}" ] && __mkt_tok="$__mkt_tok GH_PAT"
  [ -n "${GH_TOKEN:-}" ] && __mkt_tok="$__mkt_tok GH_TOKEN"
  [ -n "${GITHUB_TOKEN:-}" ] && __mkt_tok="$__mkt_tok GITHUB_TOKEN"
  echo "cloud-setup: auth tokens present at build:${__mkt_tok:- NONE}" >&2
  # The registry must be valid JSON before jq can merge into it (merging, not
  # clobbering, preserves entries Claude Code wrote natively, e.g. the default
  # claude-plugins-official registration).
  jq -e . "$__mkt_reg" >/dev/null 2>&1 || printf '{}\n' >"$__mkt_reg" || true
  while IFS=$'\t' read -r __mkt_name __mkt_repo; do
    { [ -n "$__mkt_name" ] && [ -n "$__mkt_repo" ]; } || continue
    __mkt_dst="$__mkt_root/$__mkt_name"
    if [ -d "$__mkt_dst/.git" ]; then
      GIT_TERMINAL_PROMPT=0 GIT_CONFIG_GLOBAL=/dev/null \
        git -C "$__mkt_dst" -c "credential.helper=$__mkt_helper" \
        pull --ff-only --quiet >/dev/null 2>&1 || true
    else
      rm -rf "$__mkt_dst"
      GIT_TERMINAL_PROMPT=0 GIT_CONFIG_GLOBAL=/dev/null \
        git -c "credential.helper=$__mkt_helper" \
        clone --quiet --depth 1 "https://github.com/${__mkt_repo}.git" "$__mkt_dst" \
        >/dev/null 2>&1 || true
    fi
    if [ -d "$__mkt_dst/.git" ]; then
      __mkt_tmp="$(mktemp)"
      if jq --arg name "$__mkt_name" --arg repo "$__mkt_repo" \
        --arg loc "$__mkt_dst" --arg ts "$__mkt_now" \
        '. + {($name): {source: {source: "github", repo: $repo}, installLocation: $loc, lastUpdated: $ts}}' \
        "$__mkt_reg" >"$__mkt_tmp" 2>/dev/null; then
        mv "$__mkt_tmp" "$__mkt_reg" || true
        __mkt_ok="$__mkt_ok $__mkt_name"
      else
        rm -f "$__mkt_tmp"
        __mkt_bad="$__mkt_bad $__mkt_name(register)"
      fi
    else
      __mkt_bad="$__mkt_bad $__mkt_name(clone)"
    fi
  done <<EOF
$__mkt_pairs
EOF
  # Cache materialization: registration + clone alone is NOT enough — each
  # enabled plugin must ALSO be installed into
  # ~/.claude/plugins/cache/<marketplace>/<plugin> or startup resolution drops
  # it with "plugin-cache-miss ... run /plugin to refresh" (verified against
  # the bundled CLI: with only the registry pre-seeded, sessions logged
  # "Found 0 plugins"; after installs, "Found 19 plugins"). Use the CLI's own
  # installer so the manifest and cache match whatever the running Claude
  # Code version expects instead of mimicking its on-disk format. Idempotent
  # ("already installed" no-ops); per-plugin non-fatal with a 60s cap; only
  # plugins whose marketplace seeded OK are attempted — the rest are already
  # reported by the marketplace summary below. Scope MUST be user, not
  # project: project scope keys the install record to THIS build's repo root
  # as projectPath, but a multi-repo cloud session (extra repos attached via
  # "Add repos") checks the repos out under a parent directory and launches
  # with cwd = that parent — no project record matches, and EVERY plugin is
  # dropped at startup as "plugin-cache-miss" despite a fully seeded cache
  # (observed live 2026-08: 24 installed, 0 loaded). User scope applies in
  # any session cwd and records the enable state in the user settings
  # ($HOME/.claude/settings.json, read in every session), which multi-repo
  # sessions also need: the carrier's project settings are not the session's
  # project settings there. User scope also leaves the repo carrier
  # untouched (project scope rewrote it cosmetically and needed a
  # git-checkout restore here).
  if command -v claude >/dev/null 2>&1; then
    while IFS= read -r __mkt_plugin; do
      [ -n "$__mkt_plugin" ] || continue
      case " $__mkt_ok " in
      *" ${__mkt_plugin##*@} "*) ;;
      *) continue ;;
      esac
      timeout 60 claude plugin install "$__mkt_plugin" --scope user </dev/null >/dev/null 2>&1 ||
        __mkt_bad="$__mkt_bad $__mkt_plugin(install)"
    done <<EOF
$(jq -r '(.enabledPlugins // {}) | to_entries[] | select(.value == true) | .key' .claude/settings.json 2>/dev/null)
EOF
  else
    echo "cloud-setup: claude CLI not on PATH at build time; plugin caches not materialized (plugins will not load)" >&2
  fi
  [ -n "$__mkt_ok" ] && echo "cloud-setup: pre-seeded plugin marketplaces:$__mkt_ok" >&2
  [ -n "$__mkt_bad" ] && echo "cloud-setup: marketplace pre-seed FAILED for:$__mkt_bad (private repos need GH_PAT exported in the Setup-script wrapper — the env-vars field does NOT reach snapshot builds; check network policy)" >&2
fi

# --- Workflow seeding (opt-in via a .claude-plugin/seed-workflows marker) ---
# Claude Code plugins cannot ship Workflow-tool scripts as a native component,
# and the user-scope ~/.claude/ directory never reaches cloud sessions — so a
# plugin that carries workflow .js files as inert payload (e.g. the
# claude-workflows content-vehicle plugin) needs this last-mile bridge: copy
# its workflows/<audience>/*.js flat into ~/.claude/workflows/ at SNAPSHOT
# time, where session-start name discovery finds them natively (same
# pre-seed-at-build / health-NOTE-at-session-start principle as the
# marketplace pre-seed above; the hook's clause 5c is the health side).
#   * STRICTLY opt-in: a plugin is seeded ONLY if it ships an (empty)
#     .claude-plugin/seed-workflows flag file. A workflows/ dir alone means
#     nothing — third-party plugins in the carrier must never be able to
#     inject scripts into the workflow namespace by coincidence, nor collide
#     with a future native plugin-workflow feature.
#   * Every audience dir in the payload ships (workflows/*/*.js): the cloud
#     workspace is treated as a personal workspace by invariant; audience
#     selection is a local-machine concern (the dotfiles reconciler's gates).
#   * Runs AFTER the marketplace pre-seed: it reads the plugin cache that
#     `claude plugin install` just materialized. Both cache layouts are
#     handled (cache/<mkt>/<plugin>/ and cache/<mkt>/<plugin>/<version>/).
#   * Flat copy (not symlink — the copy must not dangle if the cache moves),
#     first-wins on filename collision, duplicate-meta.name warning mirrors
#     the dotfiles reconciler. Non-fatal throughout.
__wf_cache="$HOME/.claude/plugins/cache"
__wf_dst="$HOME/.claude/workflows"
__wf_seeded=""
__wf_skipped=""
# Explicitly off in smoke mode: a self-hosted runner may carry a real
# ~/.claude/plugins/cache from another job, and seeding into the runner's home
# from a CI check would be a side effect well outside this check's remit.
if [ -z "$__smoke" ] && [ -d "$__wf_cache" ]; then
  for __wf_marker in "$__wf_cache"/*/*/.claude-plugin/seed-workflows \
    "$__wf_cache"/*/*/*/.claude-plugin/seed-workflows; do
    [ -f "$__wf_marker" ] || continue
    __wf_root="${__wf_marker%/.claude-plugin/seed-workflows}"
    for __wf_src in "$__wf_root"/workflows/*/*.js; do
      [ -f "$__wf_src" ] || continue
      mkdir -p "$__wf_dst" 2>/dev/null || true
      __wf_base="$(basename "$__wf_src")"
      if [ -e "$__wf_dst/$__wf_base" ]; then
        cmp -s "$__wf_src" "$__wf_dst/$__wf_base" || __wf_skipped="$__wf_skipped $__wf_base"
        continue
      fi
      if cp "$__wf_src" "$__wf_dst/$__wf_base" 2>/dev/null; then
        __wf_seeded="$__wf_seeded $__wf_base"
      fi
    done
  done
  if [ -n "$__wf_seeded" ]; then
    # Duplicate meta.name check over everything now in the workflow dir —
    # runtime resolution is by meta.name, so a duplicate is nondeterministic.
    __wf_dupes="$(
      for __wf_f in "$__wf_dst"/*.js; do
        [ -e "$__wf_f" ] || continue
        sed -n "s/^[[:space:]]*name:[[:space:]]*['\"]\([^'\"]*\)['\"].*/\1/p" "$__wf_f" | head -n 1
      done | sort | uniq -d | tr '\n' ' '
    )"
    [ -n "${__wf_dupes// /}" ] && echo "cloud-setup: WARNING duplicate workflow meta.name(s): $__wf_dupes— resolution is ambiguous, rename one at its source" >&2
    echo "cloud-setup: seeded workflows:$__wf_seeded" >&2
  fi
  [ -n "$__wf_skipped" ] && echo "cloud-setup: workflow seeding skipped (existing different file):$__wf_skipped" >&2
fi

# --- Cache warming (caching-only; safe to delete) ---------------------------
# Only the setup script's filesystem output is snapshotted — a session's own
# build/test never enters the cache — so warm the archetype's dependency and
# build caches here. All steps are non-fatal: a hiccup must not block the cache
# build (the SessionStart hook / test runner installs on demand if anything
# ends up missing).
#
# EVERY warm step is gated on its COMMITTED MANIFEST (go.mod, Cargo.toml,
# Gemfile + Gemfile.lock, pyproject.toml, requirements.txt, a lockfile), never
# on `command -v` alone.
# A facet says the repo COULD carry that stack; only the manifest says this
# checkout actually does. Keying on PATH instead is what made the node fallback
# run `pnpm install` at a manifest-less root on every snapshot build, and it is
# why a freshly-rendered repo — whose manifests are consumer-owned and so absent
# until the consumer writes them — would otherwise fail its own first build.
# Absent manifest = nothing to warm, silently. Tool missing WITH a manifest
# present = a real defect, reported by __smoke_check_failed in smoke mode.
# Node/TS: warm node_modules so it lands in the
# snapshot. EVERY branch is keyed off a COMMITTED file, never PATH order.
#
# Both halves of that rule were learned from the same defect class. First, an
# unconditional pnpm-first preference minted a stray pnpm-lock.yaml into an npm
# repo's snapshot, tripping the stop hook's untracked-files check in every
# session — fixed by keying the two lockfile branches. But the bare
# `command -v` fallbacks survived that fix and reintroduced it from the other
# side: the cloud base image ships pnpm, so the fallback fired on PATH alone and
#   * a repo with NO root manifest ran `pnpm install` at the repo root and
#     FAILED on every snapshot build — guaranteed, for every has_embedded_web
#     consumer, whose web project is nested by definition;
#   * a repo WITH a manifest but no committed lockfile minted one into the
#     snapshot — the original bug, via the other branch.
# So there is no bare fallback any more. A manifest with no committed lockfile
# is a conformance defect (the NPM-LOCKFILE-PRESENT audit rule), not something
# to paper over by installing here.
if [ -f package-lock.json ] && command -v npm >/dev/null 2>&1; then
  (npm ci || npm install) >/dev/null 2>&1 || __warn "npm install"
elif [ -f pnpm-lock.yaml ] && command -v pnpm >/dev/null 2>&1; then
  (pnpm install --frozen-lockfile || pnpm install) >/dev/null 2>&1 || __warn "pnpm install"
elif [ -f package.json ]; then
  echo "cloud-setup: package.json with no committed lockfile; skipping the node warm (a plain install would mint an untracked lockfile into the snapshot)" >&2
fi

# --- Repo-local additions (scripts/repo-local/cloud-setup.sh) ----------------
# REPO-OWNED, committed, never rendered by the template — the consumer's own
# cloud setup (extra apt packages, bespoke prefetch, a dockerd warm, ...) runs
# HERE, after the template-owned work above, with the same non-fatal contract.
# Absent the file this is a zero-cost no-op.
# Deliberately RUNS in smoke mode: the repo-owned half is the whole point of a
# per-consumer cloud-parity check — it is the one part of the chain the template
# cannot see, and the part most likely to assume something only the cloud image
# has.
if [ -f scripts/repo-local/cloud-setup.sh ]; then
  bash scripts/repo-local/cloud-setup.sh || __warn "scripts/repo-local/cloud-setup.sh"
fi

# --- Drift fingerprint for the SessionStart hook ----------------------------
# Snapshot-persisted sha256 of the SHIM + THIS core (concatenated) + the epoch
# it built under. The per-session hook core re-hashes the checked-out pair and
# warns when they differ (a copier-sync PR updated this core but the snapshot
# predates it -> stale snapshot until CACHE_EPOCH bump / wrapper re-save /
# ~7-day expiry). The platform can't detect this: the cache keys off the UI
# wrapper text. Non-fatal.
#
# CACHE-KEY CONVENTION (coherence-critical — do NOT change to {{ project_name }}):
# the marker is keyed on the RUNTIME checked-out directory name,
# $(basename "$repo_root"), NOT the copier `project_name` answer. The rendered
# SessionStart hook core (scripts/common/session-start-claude.sh, from S-1)
# derives its
# drift-NOTE path the SAME way — $(basename "$repo_root") — so the path this
# script WRITES and the path the hook READS are byte-identical regardless of
# whether project_name happens to match the checkout-dir name. Keying either
# side on {{ project_name }} would silently break the NOTE whenever a consumer
# clones into a directory whose name differs from project_name. (The standards
# repo's own hand-fixed hook, S-11, hardcodes the `standards` segment instead;
# that is an accepted divergence only because the standards repo basename IS
# `standards` and it has no copier project_name.)
marker_dir="${XDG_CACHE_HOME:-$HOME/.cache}/$(basename "$repo_root")"
# Not written in smoke mode: there is no snapshot to fingerprint, and a stale
# marker left in a runner's home would make a later session's drift NOTE lie.
if [ -z "$__smoke" ] && mkdir -p "$marker_dir" 2>/dev/null; then
  {
    printf 'epoch=%s\n' "${CACHE_EPOCH:-unset}"
    printf 'sha256=%s\n' "$(cat scripts/cloud-setup-shim.sh scripts/common/cloud-setup.sh 2>/dev/null | sha256sum | awk '{print $1}')"
  } >"$marker_dir/cloud-setup.built" 2>/dev/null || true
fi

# Smoke mode is the ONLY path that may exit non-zero. The cloud path below keeps
# the abort-proof contract unconditionally.
if [ -n "$__smoke" ]; then
  if [ -n "$__smoke_failures" ]; then
    echo "cloud-setup: SMOKE FAILED ($__smoke) — $__smoke_failures" >&2
    exit 1
  fi
  echo "cloud-setup: smoke OK ($__smoke)" >&2
  exit 0
fi

echo "cloud-setup: complete." >&2
exit 0
