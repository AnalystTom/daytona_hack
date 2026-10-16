#!/usr/bin/env bash
# Preview server for the integration branch (spec §2): keeps ~/preview at origin/main and serves it on :3000.
export PATH="$HOME/bin:$HOME/go/bin:$PATH"
[ -d "$HOME/preview/.git" ] || git clone -q http://localhost:3001/reversy/rebuild.git "$HOME/preview"
(cd "$HOME/preview" && setsid nohup npx -y serve -l 3000 -n . > "$HOME/preview-serve.log" 2>&1 &)
while :; do git -C "$HOME/preview" pull -q --ff-only 2>/dev/null; sleep 10; done
