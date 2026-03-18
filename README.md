# claude-lsps

LSP plugins for [Claude Code](https://claude.ai/code).

## Plugins

| Plugin | LSP Server | Description |
|--------|-----------|-------------|
| `bash-language-server` | `bash-language-server start` | Bash/Shell language server |
| `cue-lsp` | `cue lsp serve` | CUE language server (built into CUE CLI) |
| `pyright` | `pyright-langserver --stdio` | Python type checker and language server |
| `regal-lsp` | `regal language-server` | Rego linter and language server |
| `yaml-language-server` | `yaml-language-server --stdio` | YAML language server |

## Installation

Add this marketplace to your Claude Code plugins configuration, then install individual plugins.

Each plugin includes a SessionStart hook that automatically installs the LSP binary via Homebrew if it is not already available. Concurrent installs are serialized with `flock` to prevent Homebrew lock conflicts.

## License

MIT
