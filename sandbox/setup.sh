#!/usr/bin/env bash
# Installs the run snapshot's pinned toolchain and the Firstmate home. Run as root while
# building the snapshot (sandbox/Dockerfile). Safe to re-run: every step checks the pinned
# version first and skips when it is already in place. Secrets are never baked in; boot.sh
# configures them per run.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=versions.env source-path=SCRIPTDIR
. "$here/versions.env"

[ "$(id -u)" = 0 ] || {
  echo "setup.sh must run as root" >&2
  exit 1
}

# Downloads a file and refuses it unless it matches the pinned SHA-256.
fetch() {
  curl -fsSL --retry 3 -o "$3" "$1"
  echo "$2  $3" | sha256sum -c - >/dev/null
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

export DEBIAN_FRONTEND=noninteractive
if ! dpkg-query -W -f '${Version}' git 2>/dev/null | grep -q "^${GIT_APT_VERSION%\*}"; then
  apt-get update
  apt-get install -y --no-install-recommends \
    ca-certificates curl xz-utils tmux jq python3 util-linux procps \
    "git=${GIT_APT_VERSION}"
  rm -rf /var/lib/apt/lists/*
fi

if [ "$(node --version 2>/dev/null)" != "v${NODE_VERSION}" ]; then
  fetch "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    "$NODE_SHA256" "$tmp/node.tar.xz"
  tar -xJf "$tmp/node.tar.xz" -C /usr/local --strip-components=1 \
    --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md
fi

if ! codex --version 2>/dev/null | grep -q " ${CODEX_VERSION}$"; then
  npm install -g "@openai/codex@${CODEX_VERSION}"
fi

if ! no-mistakes --version 2>/dev/null | grep -q "v${NO_MISTAKES_VERSION} "; then
  fetch "https://github.com/kunchenguid/no-mistakes/releases/download/v${NO_MISTAKES_VERSION}/no-mistakes-v${NO_MISTAKES_VERSION}-linux-amd64.tar.gz" \
    "$NO_MISTAKES_SHA256" "$tmp/no-mistakes.tar.gz"
  tar -xzf "$tmp/no-mistakes.tar.gz" -C /usr/local/bin no-mistakes
fi

if ! forgejo --version 2>/dev/null | grep -q "version ${FORGEJO_VERSION}"; then
  fetch "https://codeberg.org/forgejo/forgejo/releases/download/v${FORGEJO_VERSION}/forgejo-${FORGEJO_VERSION}-linux-amd64" \
    "$FORGEJO_SHA256" "$tmp/forgejo"
  install -m 0755 "$tmp/forgejo" /usr/local/bin/forgejo
fi

if ! tea --version 2>/dev/null | grep -q "${TEA_VERSION}"; then
  fetch "https://dl.gitea.com/tea/${TEA_VERSION}/tea-${TEA_VERSION}-linux-amd64" \
    "$TEA_SHA256" "$tmp/tea"
  install -m 0755 "$tmp/tea" /usr/local/bin/tea
fi

# Forgejo refuses to run as root, so the run's processes belong to an ordinary user.
id daytona >/dev/null 2>&1 || useradd --create-home --shell /bin/bash daytona

home=/home/daytona/firstmate
as_daytona() { runuser -u daytona -- env HOME=/home/daytona "$@"; }
[ -d "$home/.git" ] || as_daytona git clone --quiet "$FIRSTMATE_REPO" "$home"
if [ "$(as_daytona git -C "$home" rev-parse HEAD)" != "$FIRSTMATE_COMMIT" ]; then
  as_daytona git -C "$home" fetch --quiet origin "$FIRSTMATE_COMMIT"
  as_daytona git -C "$home" checkout --quiet --detach "$FIRSTMATE_COMMIT"
fi

# Firstmate's own pinned, checksum-verified treehouse installer gives workers their worktrees.
command -v treehouse >/dev/null || "$home/bin/fm-install-treehouse.sh" /usr/local/bin

echo "setup.sh: toolchain ready"
