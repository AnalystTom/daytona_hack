#!/usr/bin/env bash
# Stores the run variables the Worker passes as toolbox environment (secrets included) in
# owner-only files for boot.sh and the bridge. Only adds or replaces the variables it is given.
set -euo pipefail
# shellcheck source=lib.sh source-path=SCRIPTDIR
. "$(dirname "$0")/lib.sh"

umask 077
for name in REVERSY_RUN_ID REVERSY_API_URL BRIDGE_TOKEN OPENAI_API_KEY REVERSY_POD_ID; do
  if [ -n "${!name:-}" ]; then
    printf '%s' "${!name}" >"$REVERSY_STATE/env/$name"
  fi
done
