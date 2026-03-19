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
| `yaml-language-server` | `yaml-language-server --stdio` | YAML language server |

## Installation

Add this marketplace to your Claude Code plugins configuration, then install individual plugins.

Each plugin includes a SessionStart hook that automatically installs the LSP binary if it is not already available. Most plugins install via Homebrew; `jinja-lsp` installs via Cargo. Concurrent installs are serialized with `flock` to prevent lock conflicts.

## License

MIT
