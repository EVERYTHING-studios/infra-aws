import { describe, expect, it, vi } from 'vitest';
import type { TaskRecord } from './types.js';

// billing.ts caches the parsed rate map per Lambda container; resetModules
// gives each test a fresh module instance so BILLING_RATES_JSON variants
// don't bleed across cases.
async function freshBilling(ratesJson?: string) {
  vi.resetModules();
  if (ratesJson === undefined) {
    delete process.env.BILLING_RATES_JSON;
  } else {
    process.env.BILLING_RATES_JSON = ratesJson;
  }
  return import('./billing.js');
}

function mkTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    task_id: '01JBILL01',
    type: 'text-to-3d-preview',
    status: 'SUCCEEDED',
    progress: 100,
    input: { prompt: 'a teapot' },
    options: {},
    user_id: '11111111-2222-4333-8444-555555555555',
    job_id: '99999999-8888-4777-8666-555555555555',
    created_at: '2026-09-20T12:00:00.000Z',
    updated_at: '2026-09-20T12:05:00.000Z',
    ttl: 1900000000,
    ...overrides,
  };
}

const RATES = '{"g5":844,"g6e":1556,"g7e":2333}';

describe('rateFor', () => {
  it('returns the configured rate per instance type', async () => {
    const { rateFor } = await freshBilling(RATES);
    expect(rateFor('g5')).toBe(844);
    expect(rateFor('g6e')).toBe(1556);
    expect(rateFor('g7e')).toBe(2333);
  });

  it('falls back to the g5 rate (with a warning) for unknown or missing types', async () => {
    const { rateFor } = await freshBilling(RATES);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(rateFor('g8e')).toBe(844);
      expect(rateFor(undefined)).toBe(844);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('parses only the numeric entries and ignores garbage JSON gracefully', async () => {
    const { rateFor, billingRates } = await freshBilling('{"g5":844,"g6e":"many","g7e":2333}');
    expect(billingRates()).toEqual({ g5: 844, g7e: 2333 });
    expect(rateFor('g6e')).toBe(844); // dropped entry -> g5 fallback
  });
});

describe('billableCharge', () => {
  it('charges ceil(seconds) at the instance-type rate over the capacity window', async () => {
    const { billableCharge } = await freshBilling(RATES);
    const charge = billableCharge(
      mkTask({
        capacity_started_at: '2026-09-20T12:00:00.000Z',
        inference_finished_at: '2026-09-20T12:02:30.400Z',
        inference_instance_type: 'g6e',
      }),
    );
    expect(charge).toEqual({ seconds: 151, amountMicroUsd: 151 * 1556, instanceType: 'g6e' });
  });

  it('clamps to zero when the capacity stamp lands after the finish stamp (callback race)', async () => {
    const { billableCharge } = await freshBilling(RATES);
    const charge = billableCharge(
      mkTask({
        capacity_started_at: '2026-09-20T12:06:00.000Z',
        inference_finished_at: '2026-09-20T12:05:00.000Z',
      }),
    );
    expect(charge).toEqual({ seconds: 0, amountMicroUsd: 0, instanceType: undefined });
  });

  it('falls back to inference_started_at when the capacity stamp is absent (stub backend)', async () => {
    const { billableCharge } = await freshBilling(RATES);
    const charge = billableCharge(
      mkTask({
        inference_started_at: '2026-09-20T12:00:10.000Z',
        inference_finished_at: '2026-09-20T12:00:40.000Z',
        inference_instance_type: 'g5',
      }),
    );
    expect(charge).toEqual({ seconds: 30, amountMicroUsd: 30 * 844, instanceType: 'g5' });
  });

  it('returns null when the finish stamp is missing, and when both stamps are missing', async () => {
    const { billableCharge } = await freshBilling(RATES);
    expect(billableCharge(mkTask({ capacity_started_at: '2026-09-20T12:00:00.000Z' }))).toBeNull();
    expect(billableCharge(mkTask())).toBeNull();
  });
});
