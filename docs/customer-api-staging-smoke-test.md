# Customer API — staging smoke test runbook

Run AFTER you apply `envs/staging/tfplan-customer-api` (97 adds, 15 in-place
changes, 0 destroys — includes the new `generate-staging-accounts` table,
tasks-table `gsi3`/`gsi4` in-place add, customer-webhook queue + DLQ + alarm +
dispatcher + event source mapping, 16 new routes, and 2 new authorizers).

## Prerequisites

- AWS credentials with staging deploy/read rights.
- Shared API key: `aws secretsmanager get-secret-value --secret-id generate-staging-api-key --query SecretString --output text`
- Two throwaway Supabase-style user UUIDs (any valid UUID strings work for the
  internal endpoints) — call them `UUID-A` and `UUID-B` below.
- A fresh https://webhook.site URL for receiving webhooks.
- Base URL: `https://staging-api.everythingstudios.ai` (staging runs the
  `stub` inference backend — jobs complete in seconds).

`SHARED="…"` = the Secrets Manager shared key, used as `x-api-key` on the
internal management endpoints. Capture JSON responses as you go.

## 1. Issue a key (internal endpoint)

```bash
curl -sS -X POST "https://staging-api.everythingstudios.ai/v1/accounts/$UUID_A/keys" \
  -H "x-api-key: $SHARED" -H 'content-type: application/json' \
  -d '{"label":"smoke"}'
```

Expect `201` with `{ key_id, key: "esk_…", label, created_at }`.
The `esk_…` token is shown exactly once — save it as `TOKEN_A`.

## 2. Create a job (customer endpoint)

```bash
curl -sS -X POST "https://staging-api.everythingstudios.ai/v1/jobs" \
  -H "Authorization: Bearer $TOKEN_A" -H 'content-type: application/json' \
  -d '{"type":"text-to-3d","input":{"prompt":"a red chair"}}'
```

Expect `202 { "job_id": "…" }` — save as `JOB_ID`.

**Also try the alternate credential style once** (both must be accepted):
`-H "x-api-key: $TOKEN_A"` instead of the Bearer header, and a request with
NO credential header (must 401). The customer authorizer lists both headers
as identity sources; if the x-api-key-only style unexpectedly 401s, remove
`"$request.header.Authorization"` from the authorizer's `identity_sources`
in `modules/customer-api/main.tf` and re-plan — that's a known HTTP-API
authorizer identity-source sharp edge.

## 3. Poll to completion

```bash
curl -sS "https://staging-api.everythingstudios.ai/v1/jobs/$JOB_ID" -H "Authorization: Bearer $TOKEN_A"
```

Poll until `status` is `SUCCEEDED` with non-null `model_urls.glb` at
`https://staging-assets.everythingstudios.ai/model-assets/{UUID-A}/…`.
Then confirm the task record has inference timing (stub path):

```bash
aws dynamodb get-item --table-name generate-staging-tasks \
  --key '{"pk": {"S": "TASK#'$JOB_ID'"}}' \
  --query 'Item.[inference_started_at.S, inference_finished_at.S]'
```

Both should be non-null ISO timestamps.

## 4. List + pagination + filter

```bash
curl -sS "https://staging-api.everythingstudios.ai/v1/jobs?limit=1" -H "Authorization: Bearer $TOKEN_A"
curl -sS "https://staging-api.everythingstudios.ai/v1/jobs?limit=1&cursor=$NEXT_CURSOR" -H "Authorization: Bearer $TOKEN_A"
curl -sS "https://staging-api.everythingstudios.ai/v1/jobs?status=SUCCEEDED" -H "Authorization: Bearer $TOKEN_A"
curl -sS "https://staging-api.everythingstudios.ai/v1/jobs?status=BOGUS" -H "Authorization: Bearer $TOKEN_A"
```

Expect: page 1 has `next_cursor`; following it returns page 2; the status
filter works; `BOGUS` returns `400 invalid_request`.

## 5. Cross-user isolation + revocation

```bash
# Issue a second key for UUID-B (internal), use it on UUID-A's job:
curl -sS -X POST "https://staging-api.everythingstudios.ai/v1/accounts/$UUID_B/keys" -H "x-api-key: $SHARED"
curl -sS "https://staging-api.everythingstudios.ai/v1/jobs/$JOB_ID" -H "Authorization: Bearer $TOKEN_B"
# Expect 404 (never 403 — no existence leak).

# Revoke B's key (internal), then keep using it:
curl -sS -X DELETE "https://staging-api.everythingstudios.ai/v1/accounts/$UUID_B/keys/$KEY_ID_B" -H "x-api-key: $SHARED" -i
# Expect 204. Subsequent Bearer use of TOKEN_B must 401 within <= 300 s
# (authorizer response cache TTL).
```

## 6. Webhook config + signed ping

```bash
curl -sS -X PUT "https://staging-api.everythingstudios.ai/v1/webhook-endpoint" \
  -H "Authorization: Bearer $TOKEN_A" -H 'content-type: application/json' \
  -d '{"url":"https://webhook.site/<your-id>"}'
# Expect 200 { url, secret } — capture secret.

curl -sS -X POST "https://staging-api.everythingstudios.ai/v1/webhook-endpoint/test" -H "Authorization: Bearer $TOKEN_A"
# Expect 202 { "queued": true }; a signed ping arrives at webhook.site.
```

Verify the signature locally (Node):

```js
const crypto = require('node:crypto');
// rawBody = exact raw request body from webhook.site; ts = x-generate-timestamp
console.log('sha256=' + crypto.createHmac('sha256', SECRET).update(`${ts}.${rawBody}`).digest('hex'));
// must equal the x-generate-signature header
```

## 7. Job-progress webhooks

Create another job (step 2) and watch webhook.site: `task.updated` events
should progress the job to SUCCEEDED, each signed with your per-user secret.

## 8. Web-app queue isolation

Throughout steps 2–7:
- `generate-staging-webhook-dlq-not-empty` alarm stays OK (green).
- The web-app webhook handler logs (`/aws/lambda/*` or your platform logs)
  show no unknown-task 404s — API-job events must never reach the web-app
  queue (routing is by `task.source === 'api'`).

## 9. Web-app dashboard (local dev against staging infra)

`npm run dev` in web-app, sign in as a subscribed user:
- Dashboard → Developer: create-key modal shows the `esk_…` token once with
  copy button; revoke with confirm works; key table shows status/created/last-used.
- Webhooks: save URL, secret reveal, rotate, "Send test event" all work.
- Sign in as an unsubscribed user: create-key and webhook save show the
  upgrade CTA (403 `not_subscribed` behind the scenes); list/revoke still work.

## Report back

Any step failing — send the step number, exact request/response, and the
relevant Lambda log lines (`customer-authorizer`, `create-job`,
`customer-webhook-dispatch`) back as follow-up fixes.
