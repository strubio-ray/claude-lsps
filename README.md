# claude-lsps

LSP plugins for [Claude Code](https://claude.ai/code).

## Plugins

| Plugin | LSP Server | Description |
|--------|-----------|-------------|
| `ansible-language-server` | `ansible-lsp-proxy` | Ansible language server (with LSP method compatibility proxy) |
| `bash-language-server` | `bash-language-server start` | Bash/Shell language server |
| `cue-lsp` | `cue lsp serve` | CUE language server (built into CUE CLI) |
| `jinja-lsp` | `jinja-lsp` | Jinja2 template language server |
| `pyright` | `pyright-langserver --stdio` | Python type checker and language server |
| `regal-lsp` | `regal language-server` | Rego linter and language server |
| `yaml-language-server` | `yaml-lsp-proxy` | YAML language server (with LSP method compatibility proxy) |

## Installation

Add this marketplace to your Claude Code plugins configuration, then install individual plugins.

Each plugin includes a SessionStart hook that automatically installs the LSP binary if it is not already available. Most plugins install via Homebrew; `jinja-lsp` installs via Cargo. Concurrent installs are serialized with `flock` to prevent lock conflicts.

## LSP Proxy

The `ansible-language-server` and `yaml-language-server` plugins use a shared LSP proxy (`lib/lsp-proxy.js`) that intercepts requests for unsupported methods. This prevents Claude Code's LSP client from entering a broken state when a server returns a JSON-RPC `-32601` error. Each plugin defines its blocked methods in a `proxy.json` file; a thin shell wrapper in `~/.local/bin/` is generated at session start by the plugin's hook script.

## License

MIT
