#!/usr/bin/env bash
# List customer-API jobs (GET /v1/jobs) with pagination and status filter.
#
# Inputs (env vars):
#   API_KEY         required — customer API key (esk_…)
#   LIMIT           page size 1-100 (default 20)
#   STATUS          optional filter: PENDING | IN_PROGRESS | SUCCEEDED |
#                   FAILED | CANCELED
#   CURSOR          optional pagination token (next_cursor from a prior page)
#   ALL             1 = follow next_cursor and print every page's jobs as one
#                   JSON array (default 0 = single request, print response)
#   AUTH_STYLE      bearer (default) | x-api-key
#   BASE_URL        default https://staging-api.everythingstudios.ai
#
# Usage:
#   API_KEY=esk_…  scripts/customer-api-list-jobs.sh
#   API_KEY=esk_…  STATUS=SUCCEEDED  ALL=1  scripts/customer-api-list-jobs.sh
#   API_KEY=esk_…  LIMIT=1  scripts/customer-api-list-jobs.sh   # see next_cursor
set -euo pipefail

API_KEY="${API_KEY:?API_KEY (esk_…) is required}"
LIMIT="${LIMIT:-20}"
STATUS="${STATUS:-}"
CURSOR="${CURSOR:-}"
ALL="${ALL:-0}"
AUTH_STYLE="${AUTH_STYLE:-bearer}"
BASE_URL="${BASE_URL:-https://staging-api.everythingstudios.ai}"

if [ "$AUTH_STYLE" = "x-api-key" ]; then
  AUTH=(-H "x-api-key: $API_KEY")
else
  AUTH=(-H "Authorization: Bearer $API_KEY")
fi

fetch_page() {  # $1 = cursor (may be empty)
  local url="$BASE_URL/v1/jobs?limit=$LIMIT"
  [ -n "$STATUS" ] && url="$url&status=$STATUS"
  [ -n "$1" ] && url="$url&cursor=$1"
  curl -sS -w '\n%{http_code}' "$url" "${AUTH[@]}"
}

next_cursor=""
if [ "$ALL" != "1" ]; then
  resp=$(fetch_page "$CURSOR")
  code=$(tail -1 <<<"$resp")
  body=$(head -n -1 <<<"$resp")
  echo "GET /v1/jobs?limit=$LIMIT${STATUS:+&status=$STATUS} → $code"
  jq . <<<"$body"
  [ "$code" = "200" ] || exit 1
  next_cursor=$(jq -r '.next_cursor // empty' <<<"$body")
  [ -n "$next_cursor" ] && echo "next_cursor=$next_cursor"
  exit 0
fi

# ALL=1: drain every page into one array (compact one-line jobs, assembled
# at the end; empty intermediate pages are harmless)
page=1
tmp=$(mktemp)
while :; do
  resp=$(fetch_page "$next_cursor")
  code=$(tail -1 <<<"$resp")
  body=$(head -n -1 <<<"$resp")
  if [ "$code" != "200" ]; then
    echo "page $page → HTTP $code: $body" >&2
    rm -f "$tmp"
    exit 1
  fi
  n=$(jq '.jobs | length' <<<"$body")
  echo "page $page: $n job(s)" >&2
  jq -c '.jobs[]' <<<"$body" >> "$tmp"
  next_cursor=$(jq -r '.next_cursor // empty' <<<"$body")
  [ -z "$next_cursor" ] && break
  page=$((page + 1))
done
jq -s . < "$tmp"
echo "total: $(wc -l < "$tmp") job(s) across $page page(s)" >&2
rm -f "$tmp"
