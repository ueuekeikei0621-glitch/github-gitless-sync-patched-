#!/bin/sh
# Builds the plugin and runs every end-to-end test.
# Usage: e2e/run.sh <vault repo clone> <path to its .github/scripts/sync_autofix.py>
set -e
cd "$(dirname "$0")/.."
vault=$(cd "$1" && pwd)
script=$(cd "$(dirname "$2")" && pwd)/$(basename "$2")
node e2e/transpile.js
node e2e/main-test.js
node e2e/first-sync-test.js "$vault"
node e2e/plugin-scenarios.js "$vault" "$script"
node e2e/media-scenarios.js "$vault" "$script"
node e2e/image-scenarios.js "$vault" "$script"
node e2e/large-file-scenarios.js "$vault" "$script"
# The real image encoder, in headless Chromium, when Playwright is there
if node -e 'require("playwright")' 2>/dev/null; then node e2e/image-encode-test.js; fi
