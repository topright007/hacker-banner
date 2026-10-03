#!/bin/sh
set -eu
cd "$(dirname "$0")"
./reset.sh
mkdir -p .demo-output
python3 -u collector.py .demo-output/collector.port > .demo-output/collector.log 2>&1 &
collector_pid=$!
trap 'kill "$collector_pid" 2>/dev/null || true' EXIT INT TERM

ready=0
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if [ -f .demo-output/collector.port ]; then
    DEMO_COLLECTOR_PORT=$(cat .demo-output/collector.port)
    export DEMO_COLLECTOR_PORT
    if curl --silent --fail "http://127.0.0.1:${DEMO_COLLECTOR_PORT}/health" >/dev/null; then
      ready=1
      break
    fi
  fi
  sleep 0.2
done
if [ "$ready" -ne 1 ]; then
  cat .demo-output/collector.log
  exit 1
fi

printf 'Local collector is ready. Start a second terminal with: tail -f .demo-output/collector.log\n'
if command -v pbcopy >/dev/null 2>&1 && pbcopy < TASK.txt; then
  printf 'Task copied to clipboard. Paste it into OpenCode.\n'
fi
printf 'Task is also saved in TASK.txt.\n'
opencode_bin=${OPENCODE_BIN:-}
if [ -z "$opencode_bin" ]; then
  opencode_bin=$(command -v opencode || true)
fi
if [ -z "$opencode_bin" ] && [ -x "$HOME/.opencode/bin/opencode" ]; then
  opencode_bin="$HOME/.opencode/bin/opencode"
fi
if [ -z "$opencode_bin" ]; then
  printf 'OpenCode binary not found; set OPENCODE_BIN to its path.\n' >&2
  exit 1
fi
"$opencode_bin" --standalone
printf '\nCollector log:\n'
cat .demo-output/collector.log
