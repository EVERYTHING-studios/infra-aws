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

## Results (2026-09-19, agent-run)

Executed by the agent under one-time user authorization for AWS mutations
(staging only; the "user runs all AWS mutations" rule resumes afterward).
Steps 1–8 run against `https://staging-api.everythingstudios.ai` after
`terraform apply tfplan-customer-api` (see PR for apply notes). Step 9
(dashboard E2E with a subscribed Supabase login) is **not agent-runnable —
remaining user-run check**.

| Step | Result | Evidence |
|---|---|---|
| 1 issue key | ✅ 201 | `key_id=vFkvc1I5sfsK0CtV`, label `smoke-agent`, 64-char `esk_…` token captured |
| 2 create job, both credential styles | ✅ 202/202 | Bearer → `01M2W39STGJ2CF4S3PSP3X8T2F`; `x-api-key` → `01M2W39TJ7MAMKXGXCGTBE59X1`; no-credential request denied (`403 Forbidden` — see deviation D3) |
| 3 poll to SUCCEEDED | ✅ | Job `01M2W3HQM37J9ZN3NADA5PFZBT` (image-to-3d): SUCCEEDED at 06:16:02Z (~24 min end-to-end; endpoint cold start dominated — scale-up alarm tripped 05:56Z, ~20 min to provision). `model_urls.glb` = `https://staging-assets.everythingstudios.ai/model-assets/078b4b07-…/01M2W3HQM3PQRQAY153WZESJZJ.glb` (expected pattern). DDB: `inference_started_at=2026-09-19T05:52:12.260Z`, `inference_finished_at=2026-09-19T06:16:00.250Z`, `sagemaker_region=us-east-2`, `source=api` |
| 4 pagination + filters | ✅ | `?limit=1` → `next_cursor` present; cursor page 2 returns next job (all 4 API jobs appear across pages); `?status=SUCCEEDED` → exactly the 1 succeeded job; `?status=BOGUS` → 400 `invalid_request`; `?cursor=not-base64url!` → 400 `invalid_cursor` |
| 5 isolation + revocation | ✅ | Key B (UUID_B) issued 201; Bearer TOKEN_B on A's job → `404 not_found` (never 403); internal DELETE → 204; TOKEN_B rejected **≤5 s** after revocation (immediate — per-request authorizer, see D3) |
| 6 webhook config + signed ping | ✅ | PUT `/v1/webhook-endpoint` → 200 `{url, secret}`; POST test → 202 `{queued:true}`; ping POST received at webhook.site ~10 s later; HMAC recomputed locally (node **and** python) matches `x-generate-signature` exactly |
| 7 job-progress webhooks | ✅ | `task.updated` deliveries for the step-3 job: IN_PROGRESS @ 05:52:11Z and SUCCEEDED @ 06:16:04Z; all signatures valid (spot-checked every delivery) |
| 8 queue isolation | ✅ (with pre-existing finding) | Customer webhook queue + DLQ: 0 messages, `generate-staging-customer-webhook-dlq-not-empty` OK. Zero API events reached the web-app queue. **Pre-existing:** web-app DLQ holds 21 messages from Sep 17–18 (old-format events, pre-`user_id`) and its alarm has been ALARM since Sep 13 — predates this rollout, not customer-api-related; purge/redrive is a user decision |
| 9 dashboard E2E | ⏳ user-run | Requires a subscribed Supabase login |

### Fixes landed during this run (follow-up commits on this branch)

- `fix: customer API route permissions — unique per-route statement_id` — the
  16 `aws_lambda_permission.routes` instances shared `statement_id
  = "AllowApiGateway"`; with 16 routes on 7 functions, multi-route functions
  hit AddPermission `ResourceConflictException` (indefinite provider retries,
  then a provider crash in `resourcePermissionFlatten` during apply). Now
  slugified per-route Sids.
- `fix: customer authorizer identity sources` — the plan's flagged risk
  materialized: HTTP APIs require ALL configured identity sources present or
  they 401 without invoking the authorizer, so both single-header styles
  failed. Removed `identity_sources`, set TTL 0 (required: caching needs
  identity sources). The authorizer now runs per request; revocation is
  immediate (proven in step 5).

### Deviations

- **D1 — apply aborted mid-run and completed via a fix plan.** The permission
  Sid collision (above) crashed `terraform apply tfplan-customer-api` after
  all other resources were created; `terraform plan -out=tfplan-fix && apply`
  (16 add / 5 destroy, permissions only) completed the rollout.
- **D2 — prompt-only `text-to-3d-preview` cannot run on the sagemaker
  backend.** The runbook's step-3 body (`{"type":"text-to-3d", …}`) uses an
  invalid type (actual types: `text-to-3d-preview`, `text-to-3d-refine`,
  `image-to-3d`, `multi-image-to-3d`), and prompt-only jobs of any type fail
  at dispatch: the sagemaker pipeline stages `input/0` via CopyObject but a
  prompt-only job stages no image — every prompt-only task in staging history
  (including a pre-rollout web-app one from 2026-08-23) failed with
  `AccessDenied`. Step 3 was run with `image-to-3d` + a staged test image
  (uploaded to the user-images bucket, deleted after the run). Prompt-to-3D
  on sagemaker is a pre-existing product gap, separate from this rollout.
- **D3 — deny status is 403, not 401.** With `identity_sources` removed the
  authorizer is invoked per request and API Gateway maps `isAuthorized:false`
  to `403 Forbidden` (this is standard HTTP API behavior). Steps 2c/5's
  `401` expectations become `403`; the security property (no access without
  a valid credential) is unchanged, and revocation latency improves from
  ≤300 s to immediate. Dashboard "within 5 minutes" copy remains a valid
  upper bound.
- **D4 — job objects use `task_id`** (not `id`) as the identifier field in
  list/get responses; runbook examples updated by this observation.

### Cleanup performed

Keys `vFkvc1I5sfsK0CtV` (A) and B's key revoked via internal DELETE (204,
post-revoke requests denied). Account rows for the two test UUIDs remain in
staging (harmless). webhook.site token self-expires. Test image removed from
the user-images bucket.
