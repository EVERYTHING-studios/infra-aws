import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { getSecret } from '../lib/secrets.js';
import { signWebhook, SIGNATURE_HEADER, TIMESTAMP_HEADER } from '../lib/webhook-signature.js';
import { requireEnv } from '../lib/env.js';

/**
 * SQS consumer that delivers task webhooks to the web-app. Failures are
 * reported per-message so SQS redrives them (maxReceiveCount 5 → DLQ).
 */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const webhookUrl = requireEnv('WEBHOOK_URL');
  const secret = await getSecret(requireEnv('WEBHOOK_SECRET_ARN'));
  const failures: SQSBatchResponse['batchItemFailures'] = [];

  for (const record of event.Records) {
    try {
      const timestamp = new Date().toISOString();
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [TIMESTAMP_HEADER]: timestamp,
          [SIGNATURE_HEADER]: signWebhook(secret, timestamp, record.body),
        },
        body: record.body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new Error(`Webhook endpoint returned HTTP ${response.status}`);
      }
    } catch (err) {
      console.error('Webhook delivery failed', { messageId: record.messageId, err });
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };
}
