import type { TaskRecord } from './types.js';

/**
 * Usage billing: per-second charges for API jobs over the capacity window
 * (capacity_started_at -> inference_finished_at), at 2x-margin per-instance
 * rates configured via BILLING_RATES_JSON (USD per second).
 * SUCCEEDED-only settlement happens in finalize; this lib is pure math.
 */

const DEFAULT_RATE_FALLBACK_INSTANCE = 'g5';

let cachedRates: Record<string, number> | undefined;

/** Parse BILLING_RATES_JSON once per Lambda container; unknown type falls back to the g5 rate. */
export function rateFor(instanceType: string | undefined, ratesJson = process.env.BILLING_RATES_JSON): number {
  if (!cachedRates) {
    try {
      const parsed = ratesJson ? (JSON.parse(ratesJson) as Record<string, number>) : {};
      cachedRates = Object.fromEntries(
        Object.entries(parsed).filter(([, v]) => typeof v === 'number' && Number.isFinite(v)),
      );
    } catch (err) {
      console.error(`Invalid BILLING_RATES_JSON, no rates available`, err);
      cachedRates = {};
    }
  }
  const rate = instanceType !== undefined ? cachedRates[instanceType] : undefined;
  if (rate !== undefined) return rate;
  console.warn(
    `No billing rate for instance type ${JSON.stringify(instanceType)}; falling back to ${DEFAULT_RATE_FALLBACK_INSTANCE} rate`,
  );
  return cachedRates[DEFAULT_RATE_FALLBACK_INSTANCE] ?? 0;
}

/** Parsed BILLING_RATES_JSON map (instance type -> USD/second), for display surfaces. */
export function billingRates(ratesJson = process.env.BILLING_RATES_JSON): Record<string, number> {
  rateFor(undefined, ratesJson); // prime the cache
  return { ...cachedRates };
}

export interface BillableCharge {
  seconds: number;
  amountUsd: number;
  instanceType: string | undefined;
}

/**
 * Charge for a SUCCEEDED api task, or null when the timing stamps are
 * missing (caller logs and skips — the record stays for manual settlement).
 * Start = capacity_started_at ?? inference_started_at (stub backend);
 * a promotion that lands after the callback wrote inference_finished_at
 * clamps to 0 seconds — customer-favoring.
 */
export function billableCharge(task: TaskRecord): BillableCharge | null {
  if (!task.inference_finished_at) return null;
  const startRaw = task.capacity_started_at ?? task.inference_started_at;
  if (!startRaw) return null;
  const startMs = Date.parse(startRaw);
  const finishMs = Date.parse(task.inference_finished_at);
  if (!Number.isFinite(startMs) || !Number.isFinite(finishMs)) return null;
  const seconds = Math.max(0, Math.ceil((finishMs - startMs) / 1000));
  const rate = rateFor(task.inference_instance_type);
  // Repair-only rounding: rates are <=6dp decimals and seconds an integer, so
  // the exact product is a multiple of 1e-6; Math.round on the magnitude
  // scaled by 1e6 strips float noise without changing the exact value.
  return { seconds, amountUsd: Math.round(seconds * rate * 1_000_000) / 1_000_000, instanceType: task.inference_instance_type };
}
