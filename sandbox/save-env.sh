#!/usr/bin/env bash
# Stores the run variables the Worker passes as toolbox environment (secrets included) in
# owner-only files for boot.sh and the bridge. Only adds or replaces the variables it is given.
# With REVERSY_BOOT (running or failed) it also records the boot status: running before
# boot.sh starts, so a status read does not report the previous boot's outcome, and failed
# when boot.sh could not be started.
set -euo pipefail
# shellcheck source=lib.sh source-path=SCRIPTDIR
. "$(dirname "$0")/lib.sh"

umask 077
for name in REVERSY_RUN_ID REVERSY_API_URL BRIDGE_TOKEN OPENAI_API_KEY REVERSY_POD_ID; do
  if [ -n "${!name:-}" ]; then
    printf '%s' "${!name}" >"$REVERSY_STATE/env/$name"
  fi
done
if [ -n "${REVERSY_BOOT:-}" ]; then
  echo "$REVERSY_BOOT" >"$REVERSY_STATE/boot.status"
fi
