#!/usr/bin/env bash
if ! command -v cue &>/dev/null; then
  echo "CUE CLI not found. Install with: brew install cue-lang/tap/cue"
  exit 1
fi
