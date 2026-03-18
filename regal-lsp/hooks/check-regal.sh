#!/usr/bin/env bash
# Check/install Regal for Claude Code LSP plugin

BINARY="regal"
FORMULA="styrainc/tap/regal"
LOCK_FILE="/tmp/claude-lsp-brew.lock"
LOCK_TIMEOUT=120

if command -v "$BINARY" &>/dev/null; then
  exit 0
fi

if ! command -v brew &>/dev/null; then
  echo "[$FORMULA] Homebrew not found. Install: https://brew.sh"
  exit 1
fi

# Serialized brew install (flock with mkdir fallback for macOS)
do_install() {
  echo "[$FORMULA] Installing via Homebrew..."
  if brew install "$FORMULA"; then
    echo "[$FORMULA] Installed successfully"
  else
    echo "[$FORMULA] brew install failed"
    return 1
  fi
}

if command -v flock &>/dev/null; then
  (
    flock --timeout "$LOCK_TIMEOUT" 9 || { echo "[$FORMULA] Lock timeout"; exit 1; }
    command -v "$BINARY" &>/dev/null && exit 0
    do_install
  ) 9>"$LOCK_FILE"
else
  waited=0
  while ! mkdir "$LOCK_FILE.d" 2>/dev/null; do
    if (( waited >= LOCK_TIMEOUT )); then
      echo "[$FORMULA] Lock timeout"
      exit 1
    fi
    sleep 2
    (( waited += 2 ))
  done
  trap 'rmdir "$LOCK_FILE.d" 2>/dev/null' EXIT
  command -v "$BINARY" &>/dev/null || do_install
fi

if ! command -v "$BINARY" &>/dev/null; then
  echo "[$FORMULA] Not in PATH after install. Install manually: brew install $FORMULA"
  exit 1
fi
