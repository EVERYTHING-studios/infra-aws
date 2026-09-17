import { describe, expect, it } from 'vitest';
import { classify } from './capacity-sentinel.js';

const ago = (min: number) => new Date(Date.now() - min * 60 * 1000);

describe('classify', () => {
  it('PROVISIONING while a scale-up at zero instances is younger than the 15-min staleness threshold', () => {
    expect(classify({ status: 'InService', current: 0, desired: 1,
      latestActivityStatusCode: 'InProgress', latestActivityDescription: 'Setting desired instance count to 1.',
      latestActivityStart: ago(14) })).toEqual({ class: 'PROVISIONING', proven: false });
  });

  it('DROUGHT once a scale-up at zero instances exceeds 15 min', () => {
    expect(classify({ status: 'InService', current: 0, desired: 1,
      latestActivityStatusCode: 'InProgress', latestActivityStart: ago(16) }))
      .toEqual({ class: 'DROUGHT', proven: false });
  });

  it('HEALTHY (not proven) when idle at desired 0 after a scale-down', () => {
    expect(classify({ status: 'InService', current: 0, desired: 0,
      latestActivityStatusCode: 'Successful', latestActivityDescription: 'Setting desired instance count to 0.',
      latestActivityStart: ago(5) })).toEqual({ class: 'HEALTHY', proven: false });
  });

  it('HEALTHY and proven with an instance running', () => {
    expect(classify({ status: 'InService', current: 1, desired: 1 }))
      .toEqual({ class: 'HEALTHY', proven: true });
  });

  it('FAILED on a failed endpoint', () => {
    expect(classify({ status: 'Failed', current: 0, desired: 0 }))
      .toEqual({ class: 'FAILED', proven: false });
  });
});
