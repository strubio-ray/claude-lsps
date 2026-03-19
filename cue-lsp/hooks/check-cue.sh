#!/usr/bin/env bash
# Check/install CUE CLI for Claude Code LSP plugin

BINARY="cue"
FORMULA="cue-lang/tap/cue"

if command -v "$BINARY" &>/dev/null; then
  exit 0
fi

# Determine install method: Homebrew first, binary download fallback
if command -v brew &>/dev/null; then
  INSTALL_METHOD="brew"
  LOCK_FILE="/tmp/claude-lsp-brew.lock"
else
  INSTALL_METHOD="binary"
  LOCK_FILE="/tmp/claude-lsp-binary.lock"
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
    echo "[$BINARY] Installing binary from GitHub..."
    local arch
    case "$(uname -m)" in
      x86_64)  arch="amd64" ;;
      aarch64|arm64) arch="arm64" ;;
      *) echo "[$BINARY] Unsupported architecture: $(uname -m)"; return 1 ;;
    esac

    local os
    os="$(uname -s | tr '[:upper:]' '[:lower:]')"
    local version="0.16.0"
    local url="https://github.com/cue-lang/cue/releases/download/v${version}/cue_v${version}_${os}_${arch}.tar.gz"
    local install_dir="${HOME}/.local/bin"
    local tmp_dir
    tmp_dir="$(mktemp -d)"

    mkdir -p "$install_dir"
    if curl -fsSL "$url" | tar xz -C "$tmp_dir"; then
      mv "$tmp_dir/cue" "$install_dir/cue"
      chmod +x "$install_dir/cue"
      echo "[$BINARY] Installed to $install_dir/cue"
    else
      echo "[$BINARY] Binary download failed"
      rm -rf "$tmp_dir"
      return 1
    fi
    rm -rf "$tmp_dir"
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

if ! command -v "$BINARY" &>/dev/null; then
  echo "[$BINARY] Not in PATH after install. Install manually: brew install $FORMULA"
  exit 1
fi
