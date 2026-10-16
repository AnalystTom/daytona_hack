#!/usr/bin/env bash
# Prepare a Daytona run sandbox for Reversy's agent system (docs/orchestrator/spec.md):
# Firstmate (orchestrator) + Codex workers, no-mistakes review, treehouse worktrees,
# Forgejo-compatible git host (Gitea binary; Forgejo is not downloadable from the sandbox) with tea.
set -euo pipefail
export PATH="$HOME/bin:$HOME/go/bin:$PATH"
mkdir -p "$HOME/bin"
log() { echo "[bootstrap $(date +%H:%M:%S)] $*"; }

log "apt: tmux jq gh golang xz"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tmux jq gh golang-go xz-utils >/dev/null

gh_release() { # repo asset-substring dest
  local url
  url=$(curl -fsSL "https://api.github.com/repos/$1/releases/latest" | jq -r --arg s "$2" '.assets[] | select(.name | contains($s)) | .browser_download_url' | head -1)
  curl -fsSL "$url" -o "$3"
}

log "no-mistakes"
gh_release kunchenguid/no-mistakes linux-amd64.tar.gz /tmp/nm.tgz && tar -xzf /tmp/nm.tgz -C "$HOME/bin" no-mistakes 2>/dev/null || tar -xzf /tmp/nm.tgz -C "$HOME/bin"
log "treehouse"
gh_release kunchenguid/treehouse linux-amd64.tar.gz /tmp/th.tgz && tar -xzf /tmp/th.tgz -C "$HOME/bin"
log "gitea"
gh_release go-gitea/gitea linux-amd64.xz /tmp/gitea.xz && xz -dc /tmp/gitea.xz > "$HOME/bin/gitea" && chmod +x "$HOME/bin/gitea"
log "tea (go install)"
GOTOOLCHAIN=auto go install gitea.dev/tea@v0.16.0  # module moved from code.gitea.io/tea, whose @latest is a stale tag

log "firstmate"
[ -d "$HOME/firstmate" ] || git clone -q https://github.com/kunchenguid/firstmate "$HOME/firstmate"

log "versions"
for b in tmux gh go no-mistakes treehouse gitea tea codex node; do printf '%-12s ' "$b"; ("$b" --version 2>/dev/null || "$b" version 2>/dev/null || echo missing) | head -1; done
log done
