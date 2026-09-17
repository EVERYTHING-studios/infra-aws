import { describe, expect, it } from 'vitest';
import { parseRegionConfig } from './sagemaker.js';

describe('parseRegionConfig', () => {
  it('parses a JSON array preserving order (failback priority)', () => {
    const configs = parseRegionConfig(
      JSON.stringify([
        { region: 'us-east-2', endpointName: 'e2', inputBucket: 'b2' },
        { region: 'us-east-1', endpointName: 'e1', inputBucket: 'b1' },
      ]),
    );
    expect(configs).toEqual([
      { region: 'us-east-2', endpointName: 'e2', inputBucket: 'b2' },
      { region: 'us-east-1', endpointName: 'e1', inputBucket: 'b1' },
    ]);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseRegionConfig('not json')).toThrow(/not valid JSON/);
  });

  it('rejects non-array payloads, including the legacy object form', () => {
    expect(() => parseRegionConfig('{"us-east-1":{"endpointName":"e","inputBucket":"b"}}')).toThrow(
      /JSON array/,
    );
    expect(() => parseRegionConfig('["us-east-1"]')).toThrow(/objects with region, endpointName and inputBucket/);
    expect(() => parseRegionConfig('null')).toThrow(/JSON array/);
  });

  it('rejects entries missing region, endpointName or inputBucket', () => {
    expect(() => parseRegionConfig('[{"region":"us-east-1","endpointName":"e"}]')).toThrow(
      /missing string region\/endpointName\/inputBucket/,
    );
  });

  it('rejects duplicate regions', () => {
    expect(() =>
      parseRegionConfig(
        JSON.stringify([
          { region: 'us-east-1', endpointName: 'e1', inputBucket: 'b1' },
          { region: 'us-east-1', endpointName: 'e1', inputBucket: 'b1' },
        ]),
      ),
    ).toThrow(/duplicate regions: us-east-1/);
  });

  it('rejects an empty array', () => {
    expect(() => parseRegionConfig('[]')).toThrow(/empty/);
  });
});
