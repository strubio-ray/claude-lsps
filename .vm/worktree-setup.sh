#!/usr/bin/env bash
# =============================================================================
# Project-Specific Worktree Setup Script
# =============================================================================
# This script runs automatically when `workmux add` creates a new worktree.
# Customize it for your project's needs (e.g., installing dependencies).
#
# Unlike provision.sh (which runs inside VMs), this runs on the HOST machine
# inside the newly created worktree directory.
#
# Note: worktree-setup.sh is gitignored by default. If you want to share
# setup with your team, remove it from .gitignore.
# =============================================================================

set -euo pipefail

echo "=== Running worktree setup ==="

# ---- Dependency Installation ----

# Example: Install Node.js dependencies
# if [ -f package-lock.json ] && [ ! -d node_modules ]; then
#   echo "Installing Node.js dependencies..."
#   npm ci
# fi

# Example: Install pnpm dependencies
# if [ -f pnpm-lock.yaml ] && [ ! -d node_modules ]; then
#   echo "Installing pnpm dependencies..."
#   pnpm install --frozen-lockfile
# fi

# Example: Install Python dependencies
# if [ -f requirements.txt ] && [ ! -d .venv ]; then
#   echo "Installing Python dependencies..."
#   python3 -m venv .venv
#   .venv/bin/pip install -r requirements.txt
# fi

# Example: Install dependencies in a subdirectory
# if [ -f web/pnpm-lock.yaml ] && [ ! -d web/node_modules ]; then
#   echo "Installing web dependencies..."
#   (cd web && pnpm install --frozen-lockfile)
# fi

echo "=== Worktree setup complete ==="
