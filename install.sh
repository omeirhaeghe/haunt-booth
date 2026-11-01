#!/bin/bash
# Haunt Booth installer: checks Node, then runs the setup wizard. No npm packages to download.
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18+ is required."
  if command -v brew >/dev/null 2>&1; then
    read -r -p "Install it now with Homebrew? [Y/n] " yn
    [[ "$yn" =~ ^[Nn] ]] && exit 1
    brew install node
  else
    echo "Download it from https://nodejs.org (LTS), then run ./install.sh again."
    exit 1
  fi
fi
major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 18 ]; then echo "Node $(node -v) is too old, please install Node 18 or newer."; exit 1; fi
chmod +x start.command 2>/dev/null || true
node setup.js
