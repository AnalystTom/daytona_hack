#!/usr/bin/env bash
# Preview server: serves the rebuild's integration branch (main on Forgejo) on PREVIEW_PORT
# and rebuilds it after every merge. A project with a build script is served from a copy of
# each successful build's dist/, anything else from the checkout itself. A failed build
# keeps the last good preview.
set -uo pipefail
# shellcheck source=lib.sh source-path=SCRIPTDIR
. "$(dirname "$0")/lib.sh"

checkout="$HOME/preview"
root="$HOME/preview-root"
builds="$HOME/preview-builds"
mkdir -p "$HOME/preview-empty"
[ -e "$root" ] || ln -sfn "$HOME/preview-empty" "$root"
python3 -m http.server "$PREVIEW_PORT" --directory "$root" &

built=""
while true; do
  if [ -d "$checkout/.git" ]; then
    git -C "$checkout" fetch --quiet origin main && git -C "$checkout" reset --quiet --hard origin/main
  else
    git clone --quiet "$FORGEJO_URL/$FORGEJO_REPO.git" "$checkout"
  fi
  rev=$(git -C "$checkout" rev-parse HEAD 2>/dev/null || true)
  if [ -n "$rev" ] && [ "$rev" != "$built" ]; then
    if jq -e '.scripts.build' "$checkout/package.json" >/dev/null 2>&1; then
      if (cd "$checkout" && npm ci && npm run build) &&
        rm -rf "${builds:?}/$rev" && mkdir -p "$builds" && cp -R "$checkout/dist" "$builds/$rev"; then
        ln -sfn "$builds/$rev" "$root"
        find "$builds" -mindepth 1 -maxdepth 1 ! -name "$rev" -exec rm -rf {} +
        built=$rev
      fi
    else
      ln -sfn "$checkout" "$root"
      built=$rev
    fi
  fi
  sleep 15
done
