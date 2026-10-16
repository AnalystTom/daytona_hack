#!/usr/bin/env bash
# Stores the run variables the Worker passes as toolbox environment (secrets included) in
# owner-only files for boot.sh and the bridge. Only adds or replaces the variables it is given.
# With REVERSY_BOOT set it also marks the boot running, so a status read before boot.sh
# starts does not report the previous boot's outcome.
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
  echo running >"$REVERSY_STATE/boot.status"
fi
