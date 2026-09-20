#!/usr/bin/env bash
# Check a customer-API job's status (GET /v1/jobs/{job_id}).
#
# Inputs (env vars / args):
#   JOB_ID          the job id from customer-api-create-job.sh (arg 1 or env)
#   API_KEY         required — customer API key (esk_…)
#   WAIT            0 (default) = single check; 1 = poll until terminal state
#   INTERVAL        poll interval seconds when WAIT=1 (default 15)
#   TIMEOUT         max wait seconds when WAIT=1 (default 1500 — covers a
#                   staging cold start; warm runs finish in ~1 min)
#   AUTH_STYLE      bearer (default) | x-api-key
#   BASE_URL        default https://staging-api.everythingstudios.ai
#
# Usage:
#   API_KEY=esk_…  scripts/customer-api-get-job.sh 01M2W3HQM37J9ZN3NADA5PFZBT
#   API_KEY=esk_…  WAIT=1 scripts/customer-api-get-job.sh 01M2W3HQM37J9ZN3NADA5PFZBT
#
# Exit codes (WAIT=1): 0 SUCCEEDED, 1 non-202-path error or FAILED, 3 timeout.
set -euo pipefail

JOB_ID="${1:-${JOB_ID:?JOB_ID is required (arg 1 or env)}}"
API_KEY="${API_KEY:?API_KEY (esk_…) is required}"
WAIT="${WAIT:-0}"
INTERVAL="${INTERVAL:-15}"
TIMEOUT="${TIMEOUT:-1500}"
AUTH_STYLE="${AUTH_STYLE:-bearer}"
BASE_URL="${BASE_URL:-https://staging-api.everythingstudios.ai}"

if [ "$AUTH_STYLE" = "x-api-key" ]; then
  AUTH=(-H "x-api-key: $API_KEY")
else
  AUTH=(-H "Authorization: Bearer $API_KEY")
fi

fetch() {
  curl -sS -w '\n%{http_code}' "$BASE_URL/v1/jobs/$JOB_ID" "${AUTH[@]}"
}

show() {
  jq '{status, progress, model_urls, error, created_at, finished_at}' <<<"$body"
}

if [ "$WAIT" != "1" ]; then
  resp=$(fetch)
  code=$(tail -1 <<<"$resp")
  body=$(head -n -1 <<<"$resp")
  echo "GET /v1/jobs/$JOB_ID → $code"
  if [ "$code" != "200" ]; then
    jq . <<<"$body"
    exit 1
  fi
  show "$body"
  exit 0
fi

deadline=$(( $(date +%s) + TIMEOUT ))
while :; do
  resp=$(fetch) || true
  code=$(tail -1 <<<"$resp" 2>/dev/null || echo 000)
  body=$(head -n -1 <<<"$resp" 2>/dev/null || echo '{}')
  if [ "$code" = "200" ]; then
    status=$(jq -r .status <<<"$body")
    progress=$(jq -r .progress <<<"$body")
    echo "$(date -u +%H:%M:%S) status=$status progress=$progress"
    case "$status" in
      SUCCEEDED) show "$body"; echo "model: $(jq -r .model_urls.glb <<<"$body")"; exit 0 ;;
      FAILED|CANCELED) show "$body"; exit 1 ;;
    esac
  else
    echo "$(date -u +%H:%M:%S) HTTP $code: $body"
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "timeout after ${TIMEOUT}s (job still running)" >&2
    exit 3
  fi
  sleep "$INTERVAL"
done
