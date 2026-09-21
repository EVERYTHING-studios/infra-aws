#!/usr/bin/env bash
# Trigger a customer-API render job (POST /v1/jobs) and print the job_id.
#
# Inputs (env vars):
#   API_KEY         required — a customer API key (esk_…), e.g. from the
#                   dashboard Developer page or the internal keys endpoint
#   TYPE            job type: text-to-3d-preview | text-to-3d-refine |
#                   image-to-3d | multi-image-to-3d (default image-to-3d)
#   PROMPT          required for text-to-3d-preview
#   IMAGE_URLS      comma-separated https image URLs; required for
#                   image-to-3d (exactly 1) and multi-image-to-3d (1-4)
#   PREVIEW_TASK_ID required for text-to-3d-refine (parent preview job id)
#   IDEMPOTENCY_KEY optional; re-sending the same key returns the original job
#   AUTH_STYLE      bearer (default) | x-api-key
#   BASE_URL        default https://staging-api.everythingstudios.ai
#
# Usage:
#   API_KEY=esk_…  IMAGE_URLS=https://…/chair.png  scripts/customer-api-create-job.sh
#   API_KEY=esk_…  TYPE=text-to-3d-preview  PROMPT="a red chair"  scripts/customer-api-create-job.sh
#
# Note: on the staging sagemaker backend, prompt-only text-to-3d-preview jobs
# fail at dispatch (no text-to-image step) — use image-based types for
# end-to-end runs there.
set -euo pipefail

API_KEY="${API_KEY:?API_KEY (esk_…) is required}"
TYPE="${TYPE:-image-to-3d}"
PROMPT="${PROMPT:-}"
IMAGE_URLS="${IMAGE_URLS:-}"
PREVIEW_TASK_ID="${PREVIEW_TASK_ID:-}"
IDEMPOTENCY_KEY="${IDEMPOTENCY_KEY:-}"
AUTH_STYLE="${AUTH_STYLE:-bearer}"
BASE_URL="${BASE_URL:-https://staging-api.everythingstudios.ai}"

case "$TYPE" in
  text-to-3d-preview)
    [ -n "$PROMPT" ] || { echo "error: PROMPT is required for $TYPE" >&2; exit 2; }
    INPUT=$(jq -cn --arg p "$PROMPT" '{prompt: $p}')
    ;;
  text-to-3d-refine)
    [ -n "$PREVIEW_TASK_ID" ] || { echo "error: PREVIEW_TASK_ID is required for $TYPE" >&2; exit 2; }
    INPUT=$(jq -cn --arg t "$PREVIEW_TASK_ID" '{preview_task_id: $t}')
    ;;
  image-to-3d|multi-image-to-3d)
    [ -n "$IMAGE_URLS" ] || { echo "error: IMAGE_URLS is required for $TYPE" >&2; exit 2; }
    n=$(awk -F',' '{print NF}' <<<"$IMAGE_URLS")
    if [ "$TYPE" = image-to-3d ] && [ "$n" -ne 1 ]; then
      echo "error: image-to-3d takes exactly one image URL (got $n)" >&2; exit 2
    fi
    if [ "$n" -gt 4 ]; then
      echo "error: IMAGE_URLS accepts at most 4 images (got $n)" >&2; exit 2
    fi
    INPUT=$(jq -cn --arg urls "$IMAGE_URLS" '{image_urls: ($urls | split(","))}')
    ;;
  *)
    echo "error: TYPE must be one of: text-to-3d-preview, text-to-3d-refine, image-to-3d, multi-image-to-3d" >&2
    exit 2
    ;;
esac

BODY=$(jq -cn --arg type "$TYPE" --argjson input "$INPUT" \
  --arg ik "$IDEMPOTENCY_KEY" \
  '{type: $type, input: $input} + (if $ik == "" then {} else {idempotency_key: $ik} end)')

if [ "$AUTH_STYLE" = "x-api-key" ]; then
  AUTH=(-H "x-api-key: $API_KEY")
else
  AUTH=(-H "Authorization: Bearer $API_KEY")
fi

resp=$(curl -sS -w '\n%{http_code}' -X POST "$BASE_URL/v1/jobs" \
  "${AUTH[@]}" -H 'content-type: application/json' -d "$BODY")
code=$(tail -1 <<<"$resp")
body=$(head -n -1 <<<"$resp")

echo "POST $BASE_URL/v1/jobs ($TYPE) → $code"
jq . <<<"$body"
if [ "$code" != "202" ]; then
  exit 1
fi
echo "JOB_ID=$(jq -r .job_id <<<"$body")"
