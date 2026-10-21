#!/usr/bin/env bash
# Delivers a chat message or an approved spec to Firstmate as captain input by pasting it
# into the Firstmate session, exactly as a captain typing at its prompt would.
# Input: CAPTAIN_KIND (chat or approved_spec) and CAPTAIN_TEXT in the environment.
set -euo pipefail
# shellcheck source=lib.sh source-path=SCRIPTDIR
. "$(dirname "$0")/lib.sh"

: "${CAPTAIN_TEXT:?CAPTAIN_TEXT is required}"
if ! tmux has-session -t firstmate 2>/dev/null; then
  echo "Firstmate is not running in this sandbox" >&2
  exit 1
fi

text=$CAPTAIN_TEXT
if [ "${CAPTAIN_KIND:-chat}" = approved_spec ]; then
  text=$(printf 'I approve this spec. Plan and build the rebuild from it.\n\n%s' "$CAPTAIN_TEXT")
fi

file=$(mktemp)
trap 'rm -f "$file"' EXIT
printf '%s' "$text" >"$file"
# Bracketed paste keeps a multi-line message as one prompt; Enter then submits it.
tmux load-buffer -b captain "$file"
tmux paste-buffer -p -d -b captain -t firstmate
sleep 0.5
tmux send-keys -t firstmate Enter
printf '%s %s\n' "$(date -u +%FT%TZ)" "${CAPTAIN_KIND:-chat}" >>"$REVERSY_STATE/captain-input.log"
