# shellcheck shell=bash disable=SC2034 # the variables below are used by the scripts that source this file
# Shared by the run scripts. The Worker's toolbox calls may arrive as root; Forgejo refuses
# root and the agents should not need it, so every script re-runs itself as daytona.
if [ "$(id -u)" = 0 ]; then
  exec runuser -u daytona -- env HOME=/home/daytona "$0" "$@"
fi

SCRIPTS=/opt/reversy/sandbox
REVERSY_STATE="$HOME/.reversy"
FM_HOME="$HOME/firstmate"
FORGEJO_URL=http://localhost:3000
FORGEJO_REPO=reversy/rebuild
PREVIEW_PORT=4173
mkdir -p "$REVERSY_STATE/env"

# save-env.sh stores one owner-only file per run variable; this exports them.
load_env() {
  local file
  for file in "$REVERSY_STATE"/env/*; do
    [ -f "$file" ] && export "$(basename "$file")=$(cat "$file")"
  done
  return 0
}
