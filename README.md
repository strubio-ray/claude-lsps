# claude-lsps

LSP plugins for [Claude Code](https://claude.ai/code).

## Plugins

| Plugin | LSP Server | Description |
|--------|-----------|-------------|
| `ansible-language-server` | `node lib/lsp-proxy.js` | Ansible language server (with LSP method compatibility proxy) |
| `bash-language-server` | `bash-language-server start` | Bash/Shell language server |
| `cue-lsp` | `cue lsp serve` | CUE language server (built into CUE CLI) |
| `jinja-lsp` | `jinja-lsp` | Jinja2 template language server |
| `pyright` | `pyright-langserver --stdio` | Python type checker and language server |
| `regal-lsp` | `regal language-server` | Rego linter and language server |
| `vtsls` | `vtsls --stdio` | TypeScript/JavaScript language server |
| `yaml-language-server` | `node lib/lsp-proxy.js` | YAML language server (with LSP method compatibility proxy) |

## Installation

Add this marketplace to your Claude Code plugins configuration, then install individual plugins.

Each plugin includes a SessionStart hook that automatically installs the LSP binary if it is not already available. Most plugins install via Homebrew; `jinja-lsp` installs via Cargo. Concurrent installs are serialized with `flock` to prevent lock conflicts.

## Plugin Notes

### pyright

Pyright auto-discovers a `.venv` in the project root, but projects that install dependencies via `uv run --with` (ephemeral injection) or `uv tool` won't have them visible to Pyright by default. To fix `reportMissingImports` errors, add a `pyrightconfig.json` at the project root pointing to your venv:

```json
{
  "venvPath": ".",
  "venv": ".venv"
}
```

If you don't have a `.venv` yet, create one with the dependencies your scripts need:

```bash
uv venv
uv pip install ruamel.yaml  # or whatever your scripts import
```

### regal-lsp

If your Rego policy files live in a subdirectory (e.g., `policy/`) rather than at the project root, the Regal language server needs a `project.roots` entry in `.regal/config.yaml` to resolve cross-file imports (like `import data.zone_isolation` in test files). Without this, the LSP reports false `unresolved-import` and `opa-fmt` errors because it can't find sibling packages.

```yaml
# .regal/config.yaml
project:
  roots:
    - policy   # path to your Rego files, relative to project root
```

`regal lint policy/` (CLI, whole-directory) works without this because it scans all files together. The LSP processes files individually, so it needs `project.roots` to know where to look for other packages.

## LSP Proxy

The `ansible-language-server` and `yaml-language-server` plugins use a shared LSP proxy (`lib/lsp-proxy.js`) that intercepts requests for unsupported methods. This prevents Claude Code's LSP client from entering a broken state when a server returns a JSON-RPC `-32601` error. Each plugin defines its blocked methods in a `proxy.json` file. The proxy is launched directly via `node` using `${CLAUDE_PLUGIN_ROOT}` path expansion in `.lsp.json` — no generated wrappers or PATH dependencies required.

## License

MIT
