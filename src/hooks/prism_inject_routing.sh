#!/usr/bin/env bash
# Prism v2 routing injection wrapper - delegates to python implementation.
# `prism-forge disable` drops this flag next to the hooks: stay silent
if [ -e "$(dirname "$0")/.prism-disabled" ]; then
  cat > /dev/null 2>&1 || true
  exit 0
fi
exec python "$(dirname "$0")/prism_inject_routing.py"
