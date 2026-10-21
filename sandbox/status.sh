#!/usr/bin/env bash
# Prints boot.sh's state (running, ready or failed) on the first line, then its log tail.
set -uo pipefail
# shellcheck source=lib.sh source-path=SCRIPTDIR
. "$(dirname "$0")/lib.sh"

cat "$REVERSY_STATE/boot.status" 2>/dev/null || echo unknown
tail -n 80 "$REVERSY_STATE/boot.log" 2>/dev/null
exit 0
