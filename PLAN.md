# Customer API — executed plan record

**Status: EXECUTED IN FULL — 2026-09-19**
Branch: `customer-api` in both repos (`infra-aws` + `web-app`). Changes uncommitted in the working trees.

| Part | Scope | Status |
|---|---|---|
| A1–A5 | Task data model: `source` marker, gsi3/gsi4, inference timing | ✅ done |
| B1–B10 | Accounts table, authorizers, 16 routes, 6 handlers, keys/accounts libs | ✅ done |
| C1–C3 | Customer webhook queue, DLQ, alarm, dispatcher, source routing | ✅ done |
| D1 | `envs/staging/main.tf` wiring (production deferred) | ✅ done |
| E1–E6 | Web-app client, routes, dashboard, webhook hardening, tests | ✅ done |

## Verification evidence (all run post-implementation)

- Infra (`services/generate/`): `tsc --noEmit` clean; **54/54 tests** (25 new); `npm run build` bundles all new handlers (`create-job`, `get-job`, `list-jobs`, `keys`, `webhook-endpoint`, `customer-authorizer`, `customer-webhook-dispatch`).
- Web-app: `lint:types` clean; **860/860 tests** across 84 files (new: `developer.keys.test.ts`, `developer.webhook.routes.test.ts`, extended `generate.webhook.test.ts`).
- Terraform (`envs/staging/`): `init` + `validate` pass; `terraform plan -out=tfplan-customer-api` → **97 to add, 15 in-place changes, 0 destroys** — new `generate-staging-accounts` table, in-place gsi3/gsi4 add to the tasks table (no replacement), customer-webhook queue + DLQ + alarm + dispatcher + event source mapping, 16 routes × integration/route/permission + 2 authorizers, no changes to the existing web-app queue or gateway domain. Plan file: `envs/staging/tfplan-customer-api` (user runs `terraform apply tfplan-customer-api`).
- Smoke-test runbook for the user's team: `docs/customer-api-staging-smoke-test.md`.

## Deviations from the approved plan (all minor, recorded for review)

1. **A3 repair was wider than planned**: the partial A2 edit had also dropped `inference_backend`, `idempotency_key`, and `sagemaker_task_token` from `TaskRecord` (both are load-bearing — `create-task.ts` and the SageMaker callback use them). Restored alongside the new fields.
2. **Pipeline module gained `accounts_table_name`** in addition to the planned `accounts_table_arn` — the customer webhook dispatcher needs the table *name* for its `ACCOUNTS_TABLE` env var.
3. **Authorizer context typed structurally** (plan's own contingency): this `aws-lambda` version's `APIGatewayEventRequestContextV2` lacks `authorizer`, so handlers read it via a shared `authorizerUserId()` helper in `lib/http.ts`; `customer-authorizer` returns a local `CustomerAuthorizerResponse` type (same `{ isAuthorized, context }` wire format).
4. **Webhook test-route naming collision**: the route file `developer.webhook.test.ts` (`POST /api/developer/webhook/test`) matches vitest's `*.test.ts` glob. Its colocated tests live in `developer.webhook.routes.test.ts` and `vitest.config.ts` excludes the route file (commented in config). `src/routeTree.gen.ts` regenerated via `@tanstack/router-generator`.
5. **Known risk flagged in the runbook**: the customer authorizer lists *both* `Authorization` and `x-api-key` as identity sources (per plan). HTTP API authorizers can 401 requests missing a configured identity source — runbook step 2 tests both header styles first, with the one-line `identity_sources` fix in `modules/customer-api/main.tf` if the single-header style fails.

---

# Approved plan (archived verbatim)

> The "Resume state" section below describes the working tree **as found before execution**; it is historical — every item it lists is now complete (see status table above).

## Context

Expose the existing generate service (3D render pipeline on the shared HTTP API Gateway, Step Functions, SageMaker/stub inference, DynamoDB tasks table) as a customer/developer API:

- Auth tied to the user account: per-user API keys, where a user = a Supabase `auth.users` UUID (the web-app's identity store). Keys are hashed at rest in a new DynamoDB table owned by infra.
- Endpoints: create render job, get one job, list jobs with cursor pagination + `status` filter.
- Status-change webhooks delivered to a per-user registered HTTPS endpoint, HMAC-signed with a per-user secret.
- Web-app (separate repo `~/projects/everything-studios/web-app`, TanStack Start + Supabase) issues/manages keys and webhook config from the dashboard, proxying to infra's internal management endpoints with the existing shared `GENERATE_API_KEY`.

Locked product decisions (from user):
- Keys are **per-user**, not per-organization.
- Key issuance is **paid subscribers only** (`hasActiveSubscription` in web-app); infra trusts the web-app for this gate.
- API jobs do **not** consume credits and do **not** create `generation_jobs` rows in Supabase — usage-based billing is a separate future effort. Forward-looking requirement shipped now: precise per-job inference start/end timestamps (SageMaker compute time) stored on the task record.
- Webhook signing secret is per-user and retrievable by the owner (Stripe-style), rotatable.
- **Staging only**: production wiring (`envs/production/main.tf`) is deferred until the user's team validates real use cases on staging.
- **The user runs all AWS mutations**: the agent never runs `terraform apply` (or any state-changing AWS command); the agent's infra deliverable ends at `terraform plan` validation + a smoke-test runbook. The user's team executes apply + the staging smoke test.

Branches: `customer-api` in **both** repos.

Key existing facts (verified pre-execution):
- `TaskRecord.user_id` is already the Supabase user UUID (web-app passes `output.user_id = user.id`).
- `modules/generate-api/main.tf` is the pattern for gateway routes + Lambda authorizer on the shared `modules/api-gateway` gateway.
- `services/generate/scripts/build.mjs` auto-bundles every `src/handlers/*.ts` to `dist/<name>/` — new handlers need no build-config change.
- Webhook signing contract (`services/generate/src/lib/webhook-signature.ts`): headers `x-generate-timestamp` (ISO 8601) + `x-generate-signature` (`sha256=<hex HMAC(secret, `${timestamp}.${body}`)>`).
- Web-app webhook consumer `src/routes/api/generate.webhook.ts` returned 404 for unknown `task_id` → infra dispatcher redrives → DLQ alarm. API-job events must never reach the web-app queue.
- Staging defaults: `inference_backend = "stub"`, so the stub handler must also record inference timing.

## Approach

### Part A — infra: task data model (tenancy marker, listing GSIs, inference timing)

**A1. `modules/generate-tasks/main.tf`** — add to `aws_dynamodb_table.tasks`:
- attributes `gsi3pk` (S), `gsi3sk` (S), `gsi4pk` (S)
- `global_secondary_index "gsi3"`: hash `gsi3pk`, range `gsi3sk`, projection ALL
- `global_secondary_index "gsi4"`: hash `gsi4pk`, range `gsi3sk`, projection ALL
Both stay sparse: only API-created tasks write these keys (see A3), so web-app tasks cost nothing.

**A2. `services/generate/src/lib/types.ts`** — `TaskRecord` gains:
- `source?: 'web-app' | 'api'` (absent = treat as `'web-app'`; legacy in-flight records)
- `inference_started_at?: string`
- `inference_finished_at?: string`
Do NOT add these to `ApiTask`/`toApiTask` — internal only. Extend the existing `types.test.ts` "internal fields must not leak" case with `inference_started_at`, `inference_finished_at`, `source`.

**A3. `services/generate/src/lib/tasks-repo.ts`**:
- `indexAttributes` signature becomes `Pick<TaskRecord, 'source' | 'status' | 'created_at' | 'idempotency_key'>`; when `record.source === 'api'` it additionally returns `gsi3pk = 'USER#' + user_id`, `gsi3sk = created_at`, `gsi4pk = 'USER#' + user_id + '#STATUS#' + status`. (Needs `user_id` in the Pick too.)
- `updateTask`: in the `if (updateFields.status)` branch, alongside `gsi2pk`, also set `gsi4pk = 'USER#' + task.user_id + '#STATUS#' + newStatus` **only when the existing record's source is `'api'`** — the function must read the current record; keep the write a single conditional UpdateItem as today.
- `findByIdempotencyKey(key: string, userId?: string)` — optional second arg; when present, `gsi1pk = 'USER#' + userId + '#IDEMP#' + key` (per-user idempotency scope), else the existing `'IDEMPOTENCY#' + key`. Existing caller `create-task.ts` passes one arg → unchanged behavior.
- New `listApiTasksByUser(userId, opts)` → `QueryCommand` on `gsi3` (no status) or `gsi4` (status given), `ScanIndexForward: false`, `Limit`, `ExclusiveStartKey` when present; returns `{ items, lastEvaluatedKey? }`. Empty/absent index → empty items.
- Per-user `gsi1pk` scoping in `indexAttributes` is intentional: API tasks must write the user-scoped idempotency key or `findByIdempotencyKey(key, user_id)` in B5 would never match — idempotency would silently break.

**A4. Inference timing hooks** (forward-looking usage-billing data):
- `inference-sagemaker-dispatch.ts`: the existing `updateTask` call gains `inference_started_at` (after `dispatchToRegion` succeeds).
- `inference-sagemaker-callback.ts`: `handleSuccess` gains `inference_finished_at`; `handleFailure` adds `inference_finished_at` before the `SendTaskFailure` path.
- `inference-stub.ts`: `inference_started_at` before the S3 put of the stub GLB, `inference_finished_at` after — staging runs the stub backend, so this is the path the smoke test exercises.
- Task TTL is 90 days, so these timestamps serve near-term usage-billing prototyping only; the durable billing ledger belongs to the future usage-billing work.

**A5. `services/generate/src/handlers/create-task.ts`** — set `source: 'web-app'` on the new `TaskRecord` (one line). No other change to the web-app path.

### Part B — infra: accounts/keys store, authorizers, management + jobs handlers

**B1. New Terraform module `modules/customer-api/`**:
- `aws_dynamodb_table "accounts"` named `${var.name_prefix}-accounts`, `PAY_PER_REQUEST`, hash `pk` (S), GSI `gsi1` (hash `gsi1pk`, range `gsi1sk`, ALL). Item layout:
  - `pk = USER#{user_id}`: `{ user_id, display_name?, webhook_url?, webhook_secret?, created_at, updated_at }`
  - `pk = KEY#{key_id}`: `{ key_id, user_id, key_hash, label, status: 'active'|'revoked', created_at, last_used_at? }`
  - keys also write `gsi1pk = USER#{user_id}#KEYS`, `gsi1sk = created_at` (list an account's keys).
- Handlers via `module "lambda-function"`: `customer-authorizer` (10), `keys` (10), `webhook-endpoint` (10), `create-job` (30), `get-job` (10), `list-jobs` (10).
- Two authorizers:
  - `customer`: `authorizer_type = "request"`, TTL 300, handler `customer-authorizer`, identity sources: `Authorization` header **and** `x-api-key`.
  - `internal`: handler = the existing shared-key authorizer bundle (`dist_dir = "${var.dist_dir}/authorizer"`, env `API_KEY_SECRET_ARN` = the existing secret — same check the web-app uses today).
- Routes (each: integration AWS_PROXY payload 2.0, route, lambda permission):
  - Customer-authorizer routes: `POST /v1/jobs`, `GET /v1/jobs/{id}`, `GET /v1/jobs`, `GET|PUT|DELETE /v1/webhook-endpoint`, `POST /v1/webhook-endpoint/rotate`, `POST /v1/webhook-endpoint/test`
  - Internal-authorizer routes: `POST|GET /v1/accounts/{user_id}/keys`, `DELETE /v1/accounts/{user_id}/keys/{key_id}`, `GET|PUT|DELETE /v1/accounts/{user_id}/webhook-endpoint`, `POST /v1/accounts/{user_id}/webhook-endpoint/rotate`, `POST /v1/accounts/{user_id}/webhook-endpoint/test`
- IAM policies (least privilege):
  - `customer-authorizer`: `dynamodb:GetItem`, `dynamodb:UpdateItem` on accounts table (UpdateItem only for `last_used_at` touch).
  - `keys`/`webhook-endpoint`: `dynamodb:GetItem/PutItem/UpdateItem/Query` on accounts table; `webhook-endpoint` additionally `sqs:SendMessage` on `customer_webhook_queue_arn` (test ping).
  - `create-job`: `dynamodb:GetItem/PutItem/UpdateItem/Query` on tasks table + `states:StartExecution` on state machine.
  - `get-job`: `dynamodb:GetItem` on tasks table. `list-jobs`: `dynamodb:Query` on tasks table (`table_arn/index/gsi3` and `/gsi4`).

**B2. New lib `services/generate/src/lib/api-keys.ts`**:
- `generateApiKey(): { key_id, secret, token, key_hash }` — `key_id` = 16 chars base62, `secret` = 43 chars base62 (32 bytes), `token = 'esk_' + key_id + '_' + secret`, `key_hash` = sha256 hex of `secret`.
- `parseApiKey(token)`: strict regex `^esk_([A-Za-z0-9]{16})_([A-Za-z0-9]{43})$`.
- `sha256Hex(s)` helper; constant-time compare copied from `authorizer.ts`'s `constantTimeEquals`.

**B3. New lib `services/generate/src/lib/accounts-repo.ts`** (table from `requireEnv('ACCOUNTS_TABLE')`):
- `upsertAccount(userId, displayName?)` — PutItem with `attribute_not_exists(pk)` OR update display_name (create-on-first-key).
- `getAccount(userId)`, `putApiKey(item)`, `getApiKey(keyId)`, `listKeysByUser(userId, limit=100)` (gsi1 Query), `revokeApiKey(keyId)` (UpdateItem `status='revoked'`, `attribute_exists(pk)` → throw not-found).
- `setWebhookEndpoint(userId, url, secret?)`, `getWebhookEndpoint(userId)` → `{ url, secret } | null`, `rotateWebhookSecret(userId, secret)`, `clearWebhookEndpoint(userId)` (REMOVE both attrs), `touchLastUsed(keyId)` (UpdateItem `last_used_at = now` only if stale > 60 min — conditional `last_used_at < :cutoff OR attribute_not_exists(last_used_at)`).

**B4. New handler `customer-authorizer.ts`** (modeled on `authorizer.ts`): read `Authorization: Bearer esk_...` else `x-api-key`; `parseApiKey` → null ⇒ `{ isAuthorized: false }`; `getApiKey(key_id)`; missing/revoked ⇒ false; constant-time `sha256Hex(secret)` vs `key_hash` mismatch ⇒ false; `touchLastUsed` (fire-and-forget); return `{ isAuthorized: true, context: { user_id, key_id } }` (both strings). Revocation latency ≤ 300 s (authorizer cache) — documented in dashboard copy.

**B5. New handler `create-job.ts`** (customer route only):
- New `validateCreateJob(body)` in `lib/validate.ts`: reuse the per-type `input` validation switch, accept `type`, `input`, `options?`, `idempotency_key?` (same ≤256 rule); **reject** an `output` field with `400 invalid_request 'output is not accepted on this endpoint'`.
- `user_id` from the authorizer context (assert non-empty string, else 502-style error).
- `type === 'text-to-3d-refine'`: `getTask(input.preview_task_id)`; missing, `source !== 'api'`, or `user_id` mismatch ⇒ `404 parent_not_found` (no cross-user existence leak).
- Idempotency: if `idempotency_key`, `findByIdempotencyKey(key, user_id)`; existing ⇒ `202 { job_id: existing.task_id }`.
- Build `TaskRecord`: `task_id: ulid()`, `status: 'PENDING'`, `progress: 0`, `input`, `options ?? {}`, `user_id`, `job_id: ulid()` (synthesized — final artifacts land at `${ASSETS_BASE_URL}/model-assets/{user_id}/{job_id}.glb` via the unchanged finalize step), `parent_task_id`, `artifact_prefix: parent?.artifact_prefix`, `idempotency_key`, `source: 'api'`, timestamps + `ttlFromNow()`.
- `StartExecution`, `updateTask` with `execution_arn`, respond `202 { job_id }`. No Supabase call, no credits — deliberate.

**B6. New handler `get-job.ts`**: `getTask(id)`; missing, `task.source !== 'api'`, or `task.user_id !== context user_id` ⇒ `404 { error: { code: 'not_found' } }` (404, never 403 — no existence leak). Else `200 toApiTask(task)`.

**B7. New handler `list-jobs.ts`**: `status` must be in `TASK_STATUSES` else `400 invalid_request`; `limit` integer 1–100 (default 20); `cursor` = base64url-encoded JSON of the DynamoDB exclusive-start key — decode failures ⇒ `400 invalid_cursor`. Respond `200 { jobs: items.map(toApiTask), next_cursor?: string }` (omitted when absent).

**B8. New handler `keys.ts`** (internal routes only; `user_id` always from `event.pathParameters.user_id`, never from body):
- `POST …/keys`: body `{ label? }` (string ≤ 100, else 400). `201 { key_id, key: token, label, created_at }` — full plaintext returned exactly once, never stored.
- `GET …/keys`: `200 { keys: [{ key_id, label, status, created_at, last_used_at }] }` (never the hash or token).
- `DELETE …/keys/{key_id}`: `revokeApiKey` (key must belong to this `user_id`, else 404); `204`.

**B9. New handler `webhook-endpoint.ts`** (all webhook routes, customer + internal; user resolution: `pathParameters.user_id` else authorizer context):
- `PUT`: body `{ url }`; must be `https:` (reject `http:`). Update account; if no `webhook_secret` exists, generate 43-char base62 secret and store. `200 { url, secret? }` — `secret` only when newly created.
- `GET`: `200 { url, secret }` (secret retrievable by design) or `404 not_configured`.
- `DELETE`: `204`; clears url + secret.
- `POST rotate`: new secret, `200 { secret }`.
- `POST test`: enqueue `{ event: 'ping', event_id: ulid(), user_id, timestamp }` to `CUSTOMER_WEBHOOK_QUEUE_URL`; `202 { queued: true }`; no endpoint configured ⇒ `409 not_configured`.

**B10. `lib/types.ts` webhook event**: `WebhookEvent` gains `user_id: string`, `event_id: string`, `event: 'task.updated' | 'ping'`. `webhookEventFromTask` sets both. `toApiTask` untouched.

### Part C — infra: customer webhook delivery

**C1. `modules/generate-pipeline/main.tf`** — new resources (copy the existing webhook block pattern):
- `customer_webhook_dlq` (retention 14 d), `customer_webhook` (visibility 60 s, retention 24 h, redrive `maxReceiveCount = 5`), `customer_webhook_dlq` alarm (copy of the existing DLQ alarm).
- `module "customer_webhook_dispatch"`: `dist_dir = ".../customer-webhook-dispatch"`, timeout 30, policy = `dynamodb:GetItem` on the accounts table (new module vars `accounts_table_arn` + `accounts_table_name`).
- `aws_lambda_event_source_mapping "customer_webhook"`: batch 5, `ReportBatchItemFailures`.
- New module outputs: `customer_webhook_queue_url`, `customer_webhook_queue_arn`.
- Handlers that call `enqueueWebhook` get env `CUSTOMER_WEBHOOK_QUEUE_URL` + SendMessage on the customer queue: prepare, finalize, fail-task, execution-status-watch (pipeline), cancel-task (generate-api).

**C2. `services/generate/src/lib/webhook-queue.ts`** — `enqueueWebhook` routes by source:
- `task.source === 'api'` ⇒ `CUSTOMER_WEBHOOK_QUEUE_URL` (env optional: if unset, log a warning and skip).
- otherwise (including `source` absent) ⇒ `WEBHOOK_QUEUE_URL` exactly as today. **Web-app queue behavior must remain byte-identical for non-api tasks.**

**C3. New handler `customer-webhook-dispatch.ts`** (SQS, modeled on `webhook-dispatch.ts`): per record: parse JSON; `getAccount(user_id)` — no `webhook_url`/`webhook_secret` ⇒ log + skip (count as delivered); else `fetch(url, POST, content-type + x-generate-timestamp + x-generate-signature: signWebhook(account.webhook_secret, timestamp, record.body))`, `AbortSignal.timeout(10_000)`; `!response.ok` ⇒ `batchItemFailure` (redrive → DLQ, alarm fires). Signing helpers reused verbatim from `lib/webhook-signature.ts`.

### Part D — infra: env wiring

**D1. `envs/staging/main.tf`**:
- `module "pipeline"` gains `accounts_table_name/arn = module.customer_api.*` — the only cross-module edge; no resource cycle.
- New `module "customer_api"` block (all inputs from `module.api_gateway`, `aws_secretsmanager_secret.api_key`, `module.tasks`, `module.pipeline`).
- No new Secrets Manager secrets. Production wiring deferred: `envs/production/main.tf` untouched this round.

### Part E — web-app (branch `customer-api`)

**E1. New lib `src/lib/developer-api-client.ts`** (server-only; `GENERATE_API_URL` + `GENERATE_API_KEY` env, `x-api-key` header, non-2xx ⇒ throw with status): `createDeveloperKey(userId, label?)`, `listDeveloperKeys(userId)`, `revokeDeveloperKey(userId, keyId)`, `getDeveloperWebhook(userId)`, `putDeveloperWebhook(userId, url)`, `rotateDeveloperWebhookSecret(userId)`, `deleteDeveloperWebhook(userId)`, `testDeveloperWebhook(userId)`. No new SST secrets.

**E2. New types `src/types/developer.ts`**: `DeveloperKey`, `CreateDeveloperKeyResponse`, `DeveloperWebhook` — mirroring the infra wire shapes from B8/B9.

**E3. Server routes** (session via `createClient()` + `supabase.auth.getUser()`, 401 when unauthenticated; **`user.id` always from the session, never from the request body**; gate via `hasActiveSubscription(user.id)`):
- `developer.keys.ts` — `GET` (any authenticated user) + `POST` (**403 `{ error: 'not_subscribed' }` unless subscribed**).
- `developer.keys.$keyId.ts` — `DELETE` (any authenticated user).
- `developer.webhook.ts` — `GET`/`PUT`/`DELETE`; `PUT` gated.
- `developer.webhook.rotate.ts` — `POST`, gated.
- `developer.webhook.test.ts` — `POST`, gated; returns the infra 202/409.

**E4. Dashboard page `dashboard.developer.tsx`** + `DeveloperContent` component (follow `dashboard.billing.tsx` conventions; nav entry in `dashboard.tsx`):
- "API Keys" section: table (label, `key_id`, status, created, last used); create flow gated on subscription (upgrade CTA otherwise); show-once `esk_…` modal with copy button; revoke with confirm.
- "Webhooks" section: URL input + save; secret display, rotate, "Send test event"; copy explaining `x-generate-signature` = `sha256=HMAC(secret, "${timestamp}.${body}")` and the ≤300 s revocation latency.

**E5. Harden `generate.webhook.ts`** (defense-in-depth): where `fetchError || !jobs` returned 404, a `.single()` not-found error (PGRST116) now logs and returns `200 { success: true, ignored: true }` (dispatcher treats 2xx as delivered); 404/500 semantics kept for genuine DB errors. Tests updated.

**E6. Web-app tests** (vitest, colocated): keys route — subscribed 200/201, unsubscribed 403 on POST, unauthenticated 401; revoke route; webhook routes — PUT gated, GET ungated; webhook handler ignoring unknown `task_id`.

## Verification gates (as executed)

- Infra: `npm test` (54/54), `npm run build` (all handlers bundle), `tsc --noEmit`.
- Web-app: `npm run lint:types` + `npm test` (860/860).
- Terraform: `terraform init && terraform validate && terraform plan -out=tfplan-customer-api` — 97 to add, 15 to change, 0 to destroy; in-place GSI add; no web-app queue/gateway changes. User runs `terraform apply tfplan-customer-api`.
- User-run staging smoke test per `docs/customer-api-staging-smoke-test.md` (9 steps: key issue → job create → poll to SUCCEEDED with inference timing → pagination/filter → cross-user isolation + revocation → signed ping → progress webhooks → web-app queue isolation → dashboard E2E).

## Assumptions & contingencies (from the approved plan)

- `hasActiveSubscription` (starter+) is the paid gate. If free-trial users should also issue keys, change only the web-app route guards in E3.
- API jobs don't consume credits and don't create `generation_jobs` rows — deliberate; usage billing is future work. Dashboard visibility of API jobs comes with that work (the `source: 'api'` marker is the hook).
- Task-record TTL (90 days) bounds how long inference-timing data lives; a durable billing ledger must be built with the usage-billing work — not here.
- Per-user rate limiting is deferred: the stage-level throttle (50 rps / 100 burst) is the only limit. If per-key limits are needed before billing ships, add a token-bucket check in `customer-authorizer` against the accounts table.
- Webhook secret is retrievable via authenticated GET (Stripe-style). If the leak surface becomes a concern, switch to write-only: remove `secret` from GET responses and show-once at PUT/rotate — dashboard copy (E4) is the only consumer to update.
- Authorizer-context typing contingency was exercised: local structural type used (see Deviations #3).
- DynamoDB GSI adds are in-place on provider `~> 6.0`; plan confirmed no replacement (0 destroys).
- If a pipeline handler lacks `CUSTOMER_WEBHOOK_QUEUE_URL` at runtime, `enqueueWebhook` skips the customer enqueue with a warning — web-app delivery is never blocked by customer-webhook misconfiguration.
