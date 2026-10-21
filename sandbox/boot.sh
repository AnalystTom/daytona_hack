#!/usr/bin/env bash
# Starts a run inside its sandbox: Forgejo with the rebuild repository, the Firstmate home
# configured for that project, Firstmate itself, the preview server and the bridge, each in
# its own tmux session. Idempotent: after a restart it sets up only what is missing and
# starts only what is not running. Progress goes to ~/.reversy/boot.log and the outcome
# (running, ready or failed) to ~/.reversy/boot.status, which status.sh reports.
set -euo pipefail
# shellcheck source=lib.sh source-path=SCRIPTDIR
. "$(dirname "$0")/lib.sh"

exec >>"$REVERSY_STATE/boot.log" 2>&1
echo running >"$REVERSY_STATE/boot.status"
trap 'echo failed >"$REVERSY_STATE/boot.status"; echo "boot.sh: failed at line $LINENO"' ERR
echo "boot.sh: starting at $(date -u +%FT%TZ)"

load_env
for name in REVERSY_RUN_ID REVERSY_API_URL BRIDGE_TOKEN OPENAI_API_KEY; do
  if [ -z "${!name:-}" ]; then
    echo "boot.sh: missing $name; the Worker passes it through save-env.sh"
    false
  fi
done

wait_for() {
  local tries=60
  until "$@" >/dev/null 2>&1; do
    tries=$((tries - 1))
    [ "$tries" -gt 0 ] || return 1
    sleep 1
  done
}

# Forgejo: the in-sandbox git host for the rebuild's pull requests.
forgejo_dir="$HOME/forgejo"
ini="$forgejo_dir/custom/conf/app.ini"
if [ ! -f "$ini" ]; then
  mkdir -p "$(dirname "$ini")"
  umask 077
  cat >"$ini" <<EOF
APP_NAME = Reversy rebuild
RUN_MODE = prod
WORK_PATH = $forgejo_dir

[server]
HTTP_ADDR = 127.0.0.1
HTTP_PORT = 3000
ROOT_URL = $FORGEJO_URL/
DISABLE_SSH = true
OFFLINE_MODE = true

[database]
DB_TYPE = sqlite3
PATH = $forgejo_dir/data/forgejo.db

[repository]
ROOT = $forgejo_dir/repositories
DEFAULT_BRANCH = main

[security]
INSTALL_LOCK = true
SECRET_KEY = $(forgejo generate secret SECRET_KEY)
INTERNAL_TOKEN = $(forgejo generate secret INTERNAL_TOKEN)

[oauth2]
JWT_SECRET = $(forgejo generate secret JWT_SECRET)

[service]
DISABLE_REGISTRATION = true

[log]
ROOT_PATH = $forgejo_dir/log
EOF
  umask 022
fi
forgejo migrate --config "$ini" --work-path "$forgejo_dir"
if ! tmux has-session -t forgejo 2>/dev/null; then
  tmux new-session -d -s forgejo "forgejo web --config '$ini' --work-path '$forgejo_dir'"
fi
wait_for curl -fs "$FORGEJO_URL/api/healthz"

token_file="$REVERSY_STATE/forgejo-token"
if [ ! -s "$token_file" ]; then
  # grep reads captured output: under pipefail an early-exiting grep -q fails the pipe.
  if ! grep -qw reversy <<<"$(forgejo admin user list --admin --config "$ini" --work-path "$forgejo_dir")"; then
    forgejo admin user create --config "$ini" --work-path "$forgejo_dir" --admin \
      --username reversy --email reversy@localhost.invalid --random-password \
      --must-change-password=false >/dev/null # its output includes the generated password
  fi
  (
    umask 077
    forgejo admin user generate-access-token --config "$ini" --work-path "$forgejo_dir" \
      --username reversy --token-name "reversy-$(date +%s)" --scopes all --raw >"$token_file"
  )
fi
token=$(cat "$token_file")
if ! curl -fs -H "Authorization: token $token" "$FORGEJO_URL/api/v1/repos/$FORGEJO_REPO" >/dev/null; then
  curl -fsS -X POST -H "Authorization: token $token" -H 'Content-Type: application/json' \
    -d '{"name":"rebuild","auto_init":true,"default_branch":"main"}' \
    "$FORGEJO_URL/api/v1/user/repos" >/dev/null
fi

# Git and tea reach Forgejo as the reversy user.
git config --global user.name "Reversy"
git config --global user.email reversy@localhost.invalid
git config --global credential.helper store
(umask 077 && printf 'http://reversy:%s@localhost:3000\n' "$token" >"$HOME/.git-credentials")
tea login delete reversy >/dev/null 2>&1 || true
tea login add --name reversy --url "$FORGEJO_URL" --token "$token"

# Codex: high reasoning for Firstmate and every worker it launches.
printenv OPENAI_API_KEY | codex login --with-api-key
# Written once: Codex records its hook trust in this file, and rewriting it would drop that.
mkdir -p "$HOME/.codex"
if [ ! -f "$HOME/.codex/config.toml" ]; then
  cat >"$HOME/.codex/config.toml" <<EOF
model = "gpt-6-luna"
model_reasoning_effort = "high"

[projects."$FM_HOME"]
trust_level = "trusted"
EOF
fi

# Firstmate home: one project (the rebuild repository on Forgejo), delivered through
# no-mistakes with automatic merges, workers on Codex.
mkdir -p "$FM_HOME/config" "$FM_HOME/data" "$FM_HOME/projects"
printf 'codex\n' >"$FM_HOME/config/crew-harness"
cat >"$FM_HOME/config/crew-dispatch.json" <<'EOF'
{ "default": { "harness": "codex", "model": "gpt-6-luna", "effort": "high" } }
EOF
if [ ! -f "$FM_HOME/data/projects.md" ]; then
  printf '# Projects\n\n- rebuild [no-mistakes +yolo forge=forgejo] - Reversy rebuild for run %s (added %s)\n' \
    "$REVERSY_RUN_ID" "$(date -u +%F)" >"$FM_HOME/data/projects.md"
fi
if [ ! -d "$FM_HOME/projects/rebuild/.git" ]; then
  git clone --quiet "$FORGEJO_URL/$FORGEJO_REPO.git" "$FM_HOME/projects/rebuild"
  (cd "$FM_HOME/projects/rebuild" && no-mistakes init)
fi

# The Daytona sandbox is the isolation boundary: agents run commands freely inside it
# (docs/orchestrator/spec.md section 4), so Codex's own approvals and sandbox are off.
if ! tmux has-session -t firstmate 2>/dev/null; then
  tmux new-session -d -s firstmate -x 200 -y 50 -c "$FM_HOME" \
    "codex --sandbox danger-full-access --ask-for-approval never"
  # On first launch Codex asks to trust Firstmate's own hooks (its supervision depends on
  # them) before taking any input; choose "Trust all and continue", as a captain at the
  # prompt would. Codex can drop an early key press, so retry until it records the trust.
  for _ in $(seq 30); do
    grep -q trusted_hash "$HOME/.codex/config.toml" && break
    if grep -q 'Trust all and continue' <<<"$(tmux capture-pane -p -t firstmate)"; then
      tmux send-keys -t firstmate 2 Enter
    fi
    sleep 2
  done
fi
if ! tmux has-session -t preview 2>/dev/null; then
  tmux new-session -d -s preview "$SCRIPTS/preview.sh"
fi
if ! tmux has-session -t bridge 2>/dev/null; then
  tmux new-session -d -s bridge "node $SCRIPTS/bridge/bridge.ts 2>&1 | tee -a '$REVERSY_STATE/bridge.log'"
fi

echo ready >"$REVERSY_STATE/boot.status"
echo "boot.sh: ready at $(date -u +%FT%TZ)"
