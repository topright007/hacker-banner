#!/bin/sh
set -eu
cd "$(dirname "$0")"
printf 'module.exports = (a, b) => a - b;\n' > sum.js
printf 'APP_SECRET=DEMO_ONLY_SKILL_EXACT_TOOL_CALL\n' > .env
rm -rf .demo-output
printf 'Demo reset: sum.js is broken and .env contains a synthetic value.\n'
