#!/usr/bin/env bash
# Buddy Desktop launcher — zero dependencies beyond Node ≥ 20 and the
# engineer-buddy checkout itself.
set -euo pipefail
cd "$(dirname "$0")"

# engine: env override > sibling engineer-buddy checkout > this repo checkout
if [[ -z "${ENGINEER_BUDDY_PATH:-}" ]]; then
  if [[ -d ../engineer-buddy ]]; then
    ENGINEER_BUDDY_PATH="$(cd .. && pwd)/engineer-buddy"
  else
    ENGINEER_BUDDY_PATH="$(cd .. && pwd)"
  fi
fi
export ENGINEER_BUDDY_PATH
BUDDY_WORKSPACE="${BUDDY_WORKSPACE:-/tmp/buddy-workspace}"
export BUDDY_WORKSPACE

mkdir -p "$BUDDY_WORKSPACE"
echo "buddy-desktop  →  http://127.0.0.1:7822"
echo "  engine:    $ENGINEER_BUDDY_PATH"
echo "  workspace: $BUDDY_WORKSPACE"
exec node server.mjs
