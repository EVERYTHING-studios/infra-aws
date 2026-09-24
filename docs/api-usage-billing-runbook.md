# API Usage Billing — Deploy & Smoke Runbook

Prepay balance billing for customer-API jobs (`api-usage-billing`). Rates are
2× instance cost, integer micro-USD per second, configured as Terraform locals
in `envs/{staging,production}/main.tf` (single source, passed to both the
pipeline and customer_api modules):

| Instance | µUSD/sec | Per minute |
| --- | --- | --- |
| g5  | 844  | $0.0507 |
| g6e | 1556 | $0.0933 |
| g7e | 2333 | $0.1400  |

Minimum balance to start a job: **$1.00** (1,000,000 µUSD). Billing window =
`capacity_started_at → inference_finished_at` (drought/queue waits before
instance launch are never billed; cold boot is). SUCCEEDED-only; FAILED and
CANCELED jobs are free. Settlement may drive the balance negative (accepted
overdraft); the gate only blocks starting new jobs.

## What shipped

- `capacity_started_at` stamped by the capacity sentinel on QUEUED→IN_PROGRESS
  promotion; `inference_instance_type` stamped by the sagemaker dispatcher.
- Accounts table: `balance_micro_usd` on `USER#{user_id}` + durable ledger
  items `LEDGER#{idem}` (`usage:{task_id}` | `topup:{stripe_session_id}` |
  `admin:{ulid}`), listed via gsi1 `USER#{user_id}#LEDGER`. No TTL, ever.
- Settlement in the `finalize` Lambda (api-source tasks only; billing failures
  never fail the job — recoverable via manual admin debit).
- Balance gate in `create-job`: `402 insufficient_balance` below the minimum,
  after the idempotency check (replays still return 202).
- Routes: `GET /v1/balance` (customer key), `GET/POST /v1/accounts/{user_id}/balance`
  (internal shared key — the single money-in/money-out seam).
- Web-app: dashboard Developer page "Balance & Usage" (balance, rate card,
  Stripe top-up presets $10/$25/$100 + custom $1–$1000, usage table with
  Load more, admin credit/debit sub-card), Stripe webhook fulfillment for
  `kind: api_top_up` (idempotent on the Stripe session id).

## Apply (user's team)

```bash
cd envs/staging   && terraform apply tfplan-api-billing
cd envs/production && terraform apply tfplan-api-billing
```

Expected per env: 14 to add (1 `balance` Lambda + role/policy/log group, 3
routes × integration/route/permission), 10 in-place (create-job + finalize
env/policy, plus code-hash refreshes from the rebuilt dist), 0 destroys.
Production also needs the production secret VALUES set
(`generate-production-api-key`, `-webhook-secret`) and mirrored to the web-app
SST secrets before production billing is exercisable — see
`web-app/GenerateServiceSetup.md` production section.

## Post-apply staging smoke

1. **Money in (admin path)**: `POST /v1/accounts/{UUID}/balance` with the
   shared key, `{ "amount_micro_usd": 10000000, "idempotency_key": "admin:smoke" }`
   → balance $10.00. Repeat the same idempotency_key → balance unchanged.
2. **Gate**: issue an `esk_` key, set balance to $0.50, `POST /v1/jobs` →
   `402 insufficient_balance`. Top to $1.01 → `202`.
3. **Settlement (stub backend)**: run a stub job to SUCCEEDED → ledger entry
   `usage:{task_id}`, negative amount = seconds × 844; balance decremented.
   Cancel a job mid-flight → no ledger entry. (Prompt-only `text-to-3d` fails
   pre-dispatch on sagemaker — use `image-to-3d` for real-path tests.)
4. **Settlement (sagemaker path)**: run an `image-to-3d` job cold (after
   scale-to-zero). Task record: `capacity_started_at` present, ≥ scale-up
   activity start, ≤ `inference_finished_at`; `inference_instance_type` = the
   serving token. Ledger charge = ceil(seconds) × rate-for-type. Warm second
   job: `capacity_started_at ≈ inference_started_at` (dispatch).
5. **Stripe**: `npm run stripe:webhook` forward → complete a test-payment
   Checkout for $10 → webhook credits 10,000,000 µUSD once; redeliver the
   event → still once.
6. **Customer endpoint**: `GET /v1/balance` with the `esk_` key →
   `{ balance_micro_usd, min_balance_micro_usd, rates }`.
7. **Dashboard**: Developer page shows Balance & Usage: balance, rate card,
   top-up buttons redirect to Stripe, usage table lists entries from steps
   1–5, Load more paginates. As admin: adjust another user's balance. As an
   unsubscribed user: balance view + top-up work; key creation still shows the
   upgrade CTA.

## Reconciliation contingency

If a SUCCEEDED api task ever lacks timing stamps (shouldn't happen), finalize
skips the charge and logs the task_id. Before declaring launch complete, run a
one-off reconciliation over `source='api'` SUCCEEDED tasks vs the ledger and
recover any owed charge with a manual admin **debit**.

Rate retuning (e.g. if cold-cycle recovery at 2× proves thin) is a
config-only change: edit the `billing_rates_json` local and re-apply.
