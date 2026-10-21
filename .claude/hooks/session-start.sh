#!/bin/bash
# SessionStart hook: pin the Node runtime for Claude Code cloud sessions.
#
# The maintained app in typescript/ requires Node 24 (typescript/.nvmrc,
# package.json engines ">=24 <25"). CI already pins this via actions/setup-node.
# Cloud-session containers, however, ship an older default Node (e.g. 22) and do
# not read .nvmrc, so npm/tests run on the wrong major unless we select it here.
#
# This hook sources the container's nvm, installs/activates the version pinned in
# typescript/.nvmrc, and persists it on PATH for the whole session via
# $CLAUDE_ENV_FILE. It then installs dependencies so tests and linters work.
#
# Idempotent and non-interactive. Local developers are left untouched (the hook
# no-ops outside remote sessions); they use their own nvm per README.
set -euo pipefail

# Only cloud (remote) sessions need runtime pinning. Local devs manage their own.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
TS_DIR="$PROJECT_DIR/typescript"

if [ ! -d "$TS_DIR" ]; then
  echo "session-start: typescript/ not found at $TS_DIR; skipping runtime pin" >&2
  exit 0
fi

# Locate nvm (containers place it at /opt/nvm; fall back to the user install).
export NVM_DIR="${NVM_DIR:-/opt/nvm}"
if [ ! -s "$NVM_DIR/nvm.sh" ] && [ -s "$HOME/.nvm/nvm.sh" ]; then
  NVM_DIR="$HOME/.nvm"
fi

if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  echo "session-start: nvm not found; cannot pin Node $(cat "$TS_DIR/.nvmrc" 2>/dev/null); leaving default node in place" >&2
  exit 0
fi

# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"

# Install and select the Node version pinned in typescript/.nvmrc (reads cwd .nvmrc).
cd "$TS_DIR"
nvm install
nvm use

NODE_BIN_DIR="$(dirname "$(nvm which current)")"

# Persist the pinned Node on PATH for every shell spawned this session.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  {
    echo "export NVM_DIR=\"$NVM_DIR\""
    echo "export PATH=\"$NODE_BIN_DIR:\$PATH\""
  } >> "$CLAUDE_ENV_FILE"
fi

echo "session-start: using Node $(node --version) (pinned by typescript/.nvmrc)"

# Install dependencies. npm install (not ci) so the cached container layer is reused.
npm install
