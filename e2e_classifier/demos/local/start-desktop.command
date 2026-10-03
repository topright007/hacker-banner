#!/bin/bash
# Finder-friendly launcher. Python owns the local services while the app is open.
set -euo pipefail
demo_root="$(cd "$(dirname "$0")/../.." && pwd)"
exec "$demo_root/.conda-env/bin/python" "$demo_root/demos/local/run.py" --desktop
