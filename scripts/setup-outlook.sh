#!/usr/bin/env bash
set -euo pipefail
umask 077
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
command -v pwsh >/dev/null || { echo 'PowerShell is required. Install it using the Microsoft Ubuntu instructions.'; exit 1; }
[[ "$(node -p 'process.versions.node.split(".")[0]')" == 24 ]] || { echo 'Node.js 24 is required.'; exit 1; }
cd "$repo_dir/typescript"
npm ci --ignore-scripts
pwsh -NoLogo -NoProfile -File "$repo_dir/scripts/setup-outlook.ps1"
config_path="$HOME/.config/jarvis/outlook/connections.json"
for connection in personal business; do
  if [[ -e "$HOME/.config/jarvis/outlook/$connection.token" ]]; then
    npm run outlook -- verify --config "$config_path" --connection "$connection"
  else
    npm run outlook -- connect --config "$config_path" --connection "$connection"
  fi
done
npm run outlook -- inspect --config "$config_path"
echo 'Both mailbox connections passed refresh and read-only access checks.'
echo 'Runtime remains disabled. Draft/send/reconciliation commissioning is still required.'
