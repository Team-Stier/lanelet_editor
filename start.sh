#!/bin/sh
set -eu
cd "$(dirname "$0")"
if [ -n "${LANELET_PYTHON:-}" ]; then
  python="$LANELET_PYTHON"
elif [ -x .venv/bin/python ]; then
  python=.venv/bin/python
elif [ -x /private/tmp/morai-lanelet2-20260926/venv/bin/python ]; then
  python=/private/tmp/morai-lanelet2-20260926/venv/bin/python
else
  python=python3
fi
if ! "$python" -c 'import numpy, pyproj, shapely' 2>/dev/null; then
  echo 'Install dependencies: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt' >&2
  exit 1
fi
if [ ! -f editor-assets/manifest.json ]; then
  "$python" prepare_assets.py
fi
exec "$python" server.py "$@"
