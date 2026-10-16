#!/usr/bin/env bash
# Saves a finished run as the public example shown at /workspace.
# Usage: OPERATOR_TOKEN=... scripts/save-example.sh [runId] [site]
set -euo pipefail

# The run the example is saved from; pass another finished run's ID to replace it.
EXAMPLE_RUN_ID="${1:-03b191c5-e0dc-4f8b-aa97-2e8da09db3f0}"
SITE="${2:-https://reversy.thomasmann2001.workers.dev}"
: "${OPERATOR_TOKEN:?Set OPERATOR_TOKEN to the operator token}"

curl --fail-with-body -sS -X POST "$SITE/api/v1/example" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "content-type: application/json" \
  --data "{\"runId\":\"$EXAMPLE_RUN_ID\"}"
echo
