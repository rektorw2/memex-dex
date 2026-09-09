#!/usr/bin/env bash
# Fixed implementation and regression fixtures live in the follow-up; original reports are preserved.
set -eu
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
node "$ROOT/scripts/agent-observation.mjs" "${1:-observe.csv}"
