#!/usr/bin/env bash
# Check/install yaml-language-server for Claude Code LSP plugin

BINARY="yaml-language-server"
FORMULA="yaml-language-server"
NPM_PACKAGE="yaml-language-server"

# --- Phase 1: Ensure server binary is installed ---
if ! command -v "$BINARY" &>/dev/null; then
  # Determine install method: Homebrew first, npm fallback
  if command -v brew &>/dev/null; then
    INSTALL_METHOD="brew"
    LOCK_FILE="/tmp/claude-lsp-brew.lock"
  elif command -v npm &>/dev/null; then
    INSTALL_METHOD="npm"
    LOCK_FILE="/tmp/claude-lsp-npm.lock"
  else
    echo "[$BINARY] Neither Homebrew nor npm found. Install one of them first."
    exit 1
  fi

  LOCK_TIMEOUT=120

  do_install() {
    if [ "$INSTALL_METHOD" = "brew" ]; then
      echo "[$BINARY] Installing via Homebrew..."
      if brew install "$FORMULA"; then
        echo "[$BINARY] Installed successfully"
      else
        echo "[$BINARY] brew install failed"
        return 1
      fi
    else
      echo "[$BINARY] Installing via npm..."
      if npm install -g "$NPM_PACKAGE"; then
        echo "[$BINARY] Installed successfully"
      else
        echo "[$BINARY] npm install failed"
        return 1
      fi
    fi
  }

  # Serialized install (flock with mkdir fallback for macOS)
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
fi

if ! command -v "$BINARY" &>/dev/null; then
  echo "[$BINARY] Not in PATH after install. Install manually: brew install $FORMULA"
  exit 1
fi

# --- Phase 2: Generate LSP proxy wrapper (runs every session) ---
PROXY_NAME="yaml-lsp-proxy"
PROXY_DIR="${HOME}/.local/bin"
PROXY_SCRIPT="${PROXY_DIR}/${PROXY_NAME}"
MARKETPLACE_ROOT="$(cd "${CLAUDE_PLUGIN_ROOT}/.." && pwd)"
LIB_PROXY="${MARKETPLACE_ROOT}/lib/lsp-proxy.js"
CONFIG_FILE="${CLAUDE_PLUGIN_ROOT}/proxy.json"

if [ -f "$LIB_PROXY" ] && [ -f "$CONFIG_FILE" ]; then
  mkdir -p "$PROXY_DIR"
  cat > "$PROXY_SCRIPT" <<WRAPPER
#!/bin/sh
exec node "${LIB_PROXY}" --config "${CONFIG_FILE}" "\$@"
WRAPPER
  chmod +x "$PROXY_SCRIPT"
  if ! command -v "$PROXY_NAME" &>/dev/null; then
    echo "[$PROXY_NAME] Warning: ${PROXY_DIR} is not on PATH"
  fi
fi
