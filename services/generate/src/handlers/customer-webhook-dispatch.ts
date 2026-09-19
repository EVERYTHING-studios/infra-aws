import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { getAccount } from '../lib/accounts-repo.js';
import { signWebhook, SIGNATURE_HEADER, TIMESTAMP_HEADER } from '../lib/webhook-signature.js';

/**
 * SQS consumer that delivers customer webhooks (task.updated for API jobs and
 * ping for endpoint tests) to each user's registered HTTPS endpoint, signed
 * with that user's per-user secret via the shared webhook-signature contract.
 *
 * Users without a configured endpoint count as delivered (skip) — redrive is
 * only for real delivery failures; the DLQ alarm catches those.
 */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: SQSBatchResponse['batchItemFailures'] = [];

  for (const record of event.Records) {
    try {
      const message = JSON.parse(record.body) as { event: string; user_id?: string };
      const userId = message.user_id;
      if (!userId) {
        console.error('Customer webhook message has no user_id; skipping', { messageId: record.messageId });
        continue;
      }
      const account = await getAccount(userId);
      if (!account?.webhook_url || !account.webhook_secret) {
        console.log(`User ${userId} has no webhook endpoint; skipping delivery`, {
          messageId: record.messageId,
        });
        continue;
      }
      const timestamp = new Date().toISOString();
      const response = await fetch(account.webhook_url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [TIMESTAMP_HEADER]: timestamp,
          [SIGNATURE_HEADER]: signWebhook(account.webhook_secret, timestamp, record.body),
        },
        body: record.body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new Error(`Webhook endpoint returned HTTP ${response.status}`);
      }
    } catch (err) {
      console.error('Customer webhook delivery failed', { messageId: record.messageId, err });
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };
}
