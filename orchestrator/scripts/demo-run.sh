#!/usr/bin/env bash
# Drive one full run against the orchestrator: brief -> approve -> plan -> build, printing progress.
# Usage: orchestrator/scripts/demo-run.sh [base_url]
set -euo pipefail
B=${1:-https://reversy-orchestrator.thomasmann2001.workers.dev}
j() { python3 -c "import json,sys; d=json.load(sys.stdin); $1"; }

R=$(curl -s -X POST "$B/runs" -H 'content-type: application/json' \
  -d '{"url":"https://www.daytona.io/","goal":"Rebuild the landing page faithfully, plus the create-sandbox flow with a mock back end. Flow: mock sign-in, dashboard, create sandbox (name + image), status and logs. Other routes stay links."}' | j 'print(d["id"])')
echo "run $R"
curl -s -X POST "$B/runs/$R/messages" -H 'content-type: application/json' -d '{"text":"Yes, exactly that. Spec approved, go ahead."}' | j 'print("phase", d["phase"])'

until p=$(curl -s "$B/runs/$R" | j 'print(d["phase"])') && [[ $p == planned || $p == failed || $p == brief ]]; do sleep 5; done
echo "phase $p"
[[ $p == planned ]] || exit 1
curl -s -X POST "$B/runs/$R/build" | j 'print("phase", d["phase"])'

last=""
while :; do
  s=$(curl -s "$B/runs/$R" | j 'print(d["phase"], " ".join(t["id"]+":"+t["status"] for t in d["tasks"]), (d.get("error") or "")[:120])')
  [[ $s != "$last" ]] && echo "$(date +%H:%M:%S) $s" && last=$s
  [[ $s == done* || $s == stopped* || $s == failed* ]] && break
  sleep 15
done
curl -s "$B/runs/$R" | j 'print("preview", d.get("previewUrl"))'
