#!/usr/bin/env bash
set -eu
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
node "$ROOT/scripts/agent-observation.mjs" "${1:-observe.csv}"
