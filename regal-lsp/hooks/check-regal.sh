#!/usr/bin/env bash
if ! command -v regal &>/dev/null; then
  echo "Regal not found. Install with: brew install styrainc/tap/regal"
  exit 1
fi
