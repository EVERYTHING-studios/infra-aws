import { describe, expect, it } from 'vitest';
import { parseEndpointConfig } from './sagemaker.js';

const entry = (region: string, instanceType: string, suffix = '') => ({
  region,
  instanceType,
  endpointName: `ep-${instanceType}-${region}${suffix}`,
  inputBucket: `b-${region}${suffix}`,
});

describe('parseEndpointConfig', () => {
  it('parses a JSON array preserving order (chain priority)', () => {
    const configs = parseEndpointConfig(
      JSON.stringify([
        { region: 'us-east-2', instanceType: 'g5', endpointName: 'e2', inputBucket: 'b2' },
        { region: 'us-east-1', instanceType: 'g5', endpointName: 'e1', inputBucket: 'b1' },
      ]),
    );
    expect(configs).toEqual([
      { region: 'us-east-2', instanceType: 'g5', endpointName: 'e2', inputBucket: 'b2' },
      { region: 'us-east-1', instanceType: 'g5', endpointName: 'e1', inputBucket: 'b1' },
    ]);
  });

  it('accepts multiple entries per region (the chain deploys several types per region)', () => {
    const configs = parseEndpointConfig(
      JSON.stringify([
        entry('us-east-1', 'g5'),
        entry('us-east-1', 'g6e'),
        entry('us-east-1', 'g7e'),
      ]),
    );
    expect(configs.map((c) => c.instanceType)).toEqual(['g5', 'g6e', 'g7e']);
  });

  it('rejects duplicate (region, instanceType) pairs', () => {
    expect(() =>
      parseEndpointConfig(
        JSON.stringify([
          { region: 'us-east-1', instanceType: 'g5', endpointName: 'e1', inputBucket: 'b1' },
          { region: 'us-east-1', instanceType: 'g5', endpointName: 'e1', inputBucket: 'b1' },
        ]),
      ),
    ).toThrow(/duplicate \(region, instanceType\) pairs: us-east-1\/g5/);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseEndpointConfig('not json')).toThrow(/not valid JSON/);
  });

  it('rejects non-array payloads, including the legacy object form', () => {
    expect(() => parseEndpointConfig('{"us-east-1":{"endpointName":"e","inputBucket":"b"}}')).toThrow(
      /JSON array/,
    );
    expect(() => parseEndpointConfig('["us-east-1"]')).toThrow(/objects with region, instanceType, endpointName and inputBucket/);
    expect(() => parseEndpointConfig('null')).toThrow(/JSON array/);
  });

  it('rejects entries missing region, instanceType, endpointName or inputBucket', () => {
    expect(() => parseEndpointConfig('[{"region":"us-east-1","instanceType":"g5","endpointName":"e"}]')).toThrow(
      /missing string region\/instanceType\/endpointName\/inputBucket/,
    );
    expect(() => parseEndpointConfig('[{"region":"us-east-1","endpointName":"e","inputBucket":"b"}]')).toThrow(
      /missing string region\/instanceType\/endpointName\/inputBucket/,
    );
  });

  it('rejects an empty array', () => {
    expect(() => parseEndpointConfig('[]')).toThrow(/empty/);
  });
});
