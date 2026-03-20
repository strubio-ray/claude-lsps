#!/usr/bin/env bash
# Mutual exclusion wrapper for yaml-language-server and ansible-language-server.
# Detects Ansible projects via marker files and activates the appropriate server.
# Preserves the lsp-proxy.js chain for method filtering.
#
# Assumes cwd is the project root (Claude Code's default behavior).

set -euo pipefail

MODE="${1:?Usage: yaml-or-ansible-wrapper.sh --mode=yaml|--mode=ansible}"
shift
PROXY_CONFIG="${1:?Missing --config argument}"
shift

ANSIBLE_PROJECT=false
for marker in ansible.cfg .ansible-lint; do
  if [ -f "$marker" ]; then
    ANSIBLE_PROJECT=true
    break
  fi
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

case "$MODE" in
  --mode=yaml)
    if [ "$ANSIBLE_PROJECT" = true ]; then
      echo "[yaml-language-server] Ansible project detected — deferring to ansible-language-server" >&2
      exit 1
    fi
    exec node "$SCRIPT_DIR/lsp-proxy.js" --config "$PROXY_CONFIG"
    ;;
  --mode=ansible)
    if [ "$ANSIBLE_PROJECT" = false ]; then
      echo "[ansible-language-server] Not an Ansible project — deferring to yaml-language-server" >&2
      exit 1
    fi
    exec node "$SCRIPT_DIR/lsp-proxy.js" --config "$PROXY_CONFIG"
    ;;
  *)
    echo "Unknown mode: $MODE" >&2
    exit 1
    ;;
esac
