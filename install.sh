#!/usr/bin/env bash
# opencode2-tps installer — single-file TUI speed meter plugin for OpenCode V2.
#
# What it does:
#   1. Downloads tui.js to ~/.config/opencode/plugins/tui/opencode2-tps.js
#   2. Registers the plugin path in ~/.config/opencode/cli.json, MERGING into
#      the existing "plugins" array — your other plugins and settings are
#      preserved (a one-time .bak backup is kept next to the config)
#   3. Idempotent: safe to re-run (no duplicate entries, file re-downloaded)
#
# Overrides:
#   OPENCODE2_TPS_BASE   raw-file base URL (default: GitHub raw, main branch).
#                        Set to a mirror if github raw is unreachable, e.g.
#                        https://ghproxy.net/https://raw.githubusercontent.com/BrikerMan/opencode2-tps/main
#   OPENCODE_CONFIG_DIR  opencode config dir (default: ~/.config/opencode)

set -euo pipefail

REPO_RAW="${OPENCODE2_TPS_BASE:-https://raw.githubusercontent.com/BrikerMan/opencode2-tps/main}"
OC_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
PLUGIN_DIR="$OC_DIR/plugins/tui"
CONFIG_FILE="$OC_DIR/cli.json"
PLUGIN_PATH="$PLUGIN_DIR/opencode2-tps.js"

say() { printf '%s\n' "$*"; }
die() { printf 'opencode2-tps installer: error: %s\n' "$*" >&2; exit 1; }

# --- 1. download -------------------------------------------------------------
command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || die "curl or wget is required"
mkdir -p "$PLUGIN_DIR"

say "==> Downloading tui.js"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$REPO_RAW/tui.js" -o "$PLUGIN_PATH" || die "download failed from $REPO_RAW (set OPENCODE2_TPS_BASE to a mirror?)"
else
  wget -qO "$PLUGIN_PATH" "$REPO_RAW/tui.js" || die "download failed from $REPO_RAW (set OPENCODE2_TPS_BASE to a mirror?)"
fi

# --- 2. register in cli.json (merge, never clobber) --------------------------
if [ ! -f "$CONFIG_FILE" ]; then
  say "==> Creating $CONFIG_FILE"
  printf '{\n  "plugins": []\n}\n' > "$CONFIG_FILE"
else
  cp -f "$CONFIG_FILE" "$CONFIG_FILE.bak"
  say "==> Backup: $CONFIG_FILE.bak"
fi

registered=0
if command -v jq >/dev/null 2>&1; then
  tmp="$(mktemp)"
  jq --arg p "$PLUGIN_PATH" '.plugins = ((.plugins // []) | if index($p) then . else . + [$p] end)' \
    "$CONFIG_FILE" > "$tmp" || die "$CONFIG_FILE is not valid JSON — fix or restore the .bak, then re-run"
  mv "$tmp" "$CONFIG_FILE"
  registered=1
elif command -v python3 >/dev/null 2>&1; then
  CONFIG_FILE="$CONFIG_FILE" PLUGIN_PATH="$PLUGIN_PATH" python3 - <<'PY' || die "failed to update $CONFIG_FILE"
import json, os, sys

config_file = os.environ["CONFIG_FILE"]
plugin_path = os.environ["PLUGIN_PATH"]
try:
    with open(config_file) as f:
        cfg = json.load(f)
except json.JSONDecodeError as e:
    sys.exit(f"{config_file} is not valid JSON ({e}) — fix or restore the .bak, then re-run")
plugins = cfg.get("plugins", [])
if not isinstance(plugins, list):
    sys.exit('"plugins" in cli.json is not an array — fix it, then re-run')
if plugin_path not in plugins:
    plugins.append(plugin_path)
cfg["plugins"] = plugins
with open(config_file, "w") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY
  registered=1
elif command -v node >/dev/null 2>&1; then
  CONFIG_FILE="$CONFIG_FILE" PLUGIN_PATH="$PLUGIN_PATH" node -e '
const fs = require("fs");
const { CONFIG_FILE: configFile, PLUGIN_PATH: pluginPath } = process.env;
let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(configFile, "utf8"));
} catch (e) {
  console.error(`${configFile} is not valid JSON (${e.message})`);
  process.exit(1);
}
if (!Array.isArray(cfg.plugins)) cfg.plugins = [];
if (!cfg.plugins.includes(pluginPath)) cfg.plugins.push(pluginPath);
fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2) + "\n");
' || die "failed to update $CONFIG_FILE"
  registered=1
fi

say "==> Installed: $PLUGIN_PATH"
if [ "$registered" = "1" ]; then
  say "==> Registered in: $CONFIG_FILE (existing plugins preserved)"
else
  say ""
  say "WARNING: none of jq / python3 / node found."
  say "Add this entry to the \"plugins\" array in $CONFIG_FILE yourself:"
  say "  $PLUGIN_PATH"
fi

say ""
say "Restart the OpenCode TUI — you should see TPS | AVG | TTFT beside the prompt."
say "If the meter does not appear, try: cd $OC_DIR && bun add solid-js @opentui/solid @opentui/core"
