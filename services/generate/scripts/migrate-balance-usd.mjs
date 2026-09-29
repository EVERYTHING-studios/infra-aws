// One-off migration: convert accounts-table money attributes from integer
// micro-USD to decimal USD (billing unit change).
//
//   node scripts/migrate-balance-usd.mjs --table <name> --copy   [--region us-east-1]
//   node scripts/migrate-balance-usd.mjs --table <name> --remove [--region us-east-1]
//
// --copy:  USER# rows: balance_micro_usd -> balance_usd (old / 1e6);
//          LEDGER# rows: amount_micro_usd -> amount_usd likewise. Old
//          attributes are kept (run --remove after the new code is deployed).
// --remove: drop the old *_micro_usd attributes.
//
// JS Number.toString gives the exact shortest decimal (e.g. 25320/1e6 ->
// "0.02532"), so DynamoDB stores exact values. Run --copy and the deploy
// back-to-back in a quiet window; never re-run --copy after the new code is
// live (it would overwrite newer balance_usd deltas from the drift window).
import { DynamoDBClient, ScanCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

const args = process.argv.slice(2);
function argValue(name) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
}

const table = argValue('table');
const region = argValue('region') ?? 'us-east-1';
const mode = args.includes('--copy') ? 'copy' : args.includes('--remove') ? 'remove' : undefined;

if (!table || !mode) {
  console.error('usage: node scripts/migrate-balance-usd.mjs --table <name> --copy|--remove [--region us-east-1]');
  process.exit(2);
}

const client = new DynamoDBClient({ region });
let scanned = 0;
let updated = 0;
let skipped = 0;
let failed = 0;

function toUsd(old) {
  return old / 1_000_000;
}

async function updateWithRetry(input) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await client.send(new UpdateItemCommand(input));
      return true;
    } catch (err) {
      console.error(`UpdateItem failed (attempt ${attempt}): ${JSON.stringify(input.Key)}`, err.message ?? err);
      if (attempt === 2) return false;
    }
  }
}

let lastKey;
do {
  const page = await client.send(new ScanCommand({ TableName: table, ExclusiveStartKey: lastKey }));
  for (const item of page.Items ?? []) {
    scanned++;
    const pk = item.pk?.S;
    const oldAttr = pk?.startsWith('USER#') ? 'balance_micro_usd' : pk?.startsWith('LEDGER#') ? 'amount_micro_usd' : undefined;
    if (!oldAttr || item[oldAttr] === undefined) {
      skipped++;
      continue;
    }
    const newAttr = oldAttr.replace('_micro_usd', '_usd');
    const input =
      mode === 'copy'
        ? {
            TableName: table,
            Key: { pk: item.pk },
            UpdateExpression: `SET ${newAttr} = :v`,
            // Number values marshal via JS number -> shortest exact decimal string.
            ExpressionAttributeValues: { ':v': { N: String(toUsd(Number(item[oldAttr].N))) } },
          }
        : {
            TableName: table,
            Key: { pk: item.pk },
            UpdateExpression: `REMOVE ${oldAttr}`,
          };
    if (await updateWithRetry(input)) {
      updated++;
    } else {
      failed++;
    }
  }
  lastKey = page.LastEvaluatedKey;
} while (lastKey);

console.log(`${mode}: scanned=${scanned} updated=${updated} skipped=${skipped} failed=${failed}`);
if (failed > 0) process.exit(1);
