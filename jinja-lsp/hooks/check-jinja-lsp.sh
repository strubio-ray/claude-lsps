#!/usr/bin/env bash
# Check/install jinja-lsp for Claude Code LSP plugin

BINARY="jinja-lsp"
GIT_REPO="git@github.com:uros-5/jinja-lsp.git"
LOCK_FILE="/tmp/claude-lsp-cargo.lock"
LOCK_TIMEOUT=300

if command -v "$BINARY" &>/dev/null; then
  exit 0
fi

if ! command -v cargo &>/dev/null; then
  echo "[$BINARY] Rust/Cargo not found. Install via rustup: https://rustup.rs"
  exit 1
fi

# Serialized cargo install (flock with mkdir fallback for macOS)
do_install() {
  echo "[$BINARY] Installing via Cargo (SSH)..."
  if cargo install --git "$GIT_REPO"; then
    echo "[$BINARY] Installed successfully"
  else
    echo "[$BINARY] cargo install failed"
    return 1
  fi
}

if command -v flock &>/dev/null; then
  (
    flock --timeout "$LOCK_TIMEOUT" 9 || { echo "[$BINARY] Lock timeout"; exit 1; }
    command -v "$BINARY" &>/dev/null && exit 0
    do_install
  ) 9>"$LOCK_FILE"
else
  waited=0
  while ! mkdir "$LOCK_FILE.d" 2>/dev/null; do
    if (( waited >= LOCK_TIMEOUT )); then
      echo "[$BINARY] Lock timeout"
      exit 1
    fi
    sleep 2
    (( waited += 2 ))
  done
  trap 'rmdir "$LOCK_FILE.d" 2>/dev/null' EXIT
  command -v "$BINARY" &>/dev/null || do_install
fi

if ! command -v "$BINARY" &>/dev/null; then
  echo "[$BINARY] Not in PATH after install. Install manually: cargo install --git $GIT_REPO"
  exit 1
fi
