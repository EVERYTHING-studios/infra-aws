import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEndpointConfig, parseOptionalEndpointConfig } from './sagemaker.js';

const entry = (region: string, instanceType: string, suffix = '') => ({
  region,
  instanceType,
  endpointName: `ep-${instanceType}-${region}${suffix}`,
  inputBucket: `b-${region}${suffix}`,
});

describe('parseEndpointConfig', () => {
  it('parses a JSON array preserving order (chain priority), defaulting variantName to trellis', () => {
    const configs = parseEndpointConfig(
      JSON.stringify([
        { region: 'us-east-2', instanceType: 'g5', endpointName: 'e2', inputBucket: 'b2' },
        { region: 'us-east-1', instanceType: 'g5', endpointName: 'e1', inputBucket: 'b1' },
      ]),
    );
    expect(configs).toEqual([
      { region: 'us-east-2', instanceType: 'g5', endpointName: 'e2', inputBucket: 'b2', variantName: 'trellis' },
      { region: 'us-east-1', instanceType: 'g5', endpointName: 'e1', inputBucket: 'b1', variantName: 'trellis' },
    ]);
  });

  it('carries an explicit variantName (the v2 pixal3d chain)', () => {
    const configs = parseEndpointConfig(
      JSON.stringify([
        {
          region: 'us-east-1',
          instanceType: 'g5',
          endpointName: 'svc-sagemaker-pixal3d-g5',
          inputBucket: 'in-g5-use1',
          variantName: 'pixal3d',
        },
      ]),
    );
    expect(configs[0]?.variantName).toBe('pixal3d');
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

describe('parseOptionalEndpointConfig', () => {
  it('returns [] for unset, empty, or empty-array env (chain not deployed)', () => {
    expect(parseOptionalEndpointConfig(undefined)).toEqual([]);
    expect(parseOptionalEndpointConfig('')).toEqual([]);
    expect(parseOptionalEndpointConfig('[]')).toEqual([]);
  });

  it('parses a configured chain', () => {
    const configs = parseOptionalEndpointConfig(
      JSON.stringify([
        {
          region: 'us-east-1',
          instanceType: 'g5',
          endpointName: 'svc-sagemaker-pixal3d-g5',
          inputBucket: 'in-g5-use1',
          variantName: 'pixal3d',
        },
      ]),
    );
    expect(configs).toEqual([
      {
        region: 'us-east-1',
        instanceType: 'g5',
        endpointName: 'svc-sagemaker-pixal3d-g5',
        inputBucket: 'in-g5-use1',
        variantName: 'pixal3d',
      },
    ]);
  });

  it('rejects invalid JSON and non-string variantName like the required parser', () => {
    expect(() => parseOptionalEndpointConfig('not json')).toThrow(/not valid JSON/);
    expect(() =>
      parseOptionalEndpointConfig('[{"region":"us-east-1","instanceType":"g5","endpointName":"e","inputBucket":"b","variantName":3}]'),
    ).toThrow(/variantName must be a string/);
  });
});

// --- dispatchToRegion: staged-input payload shapes -------------------------
//
// The S3/SageMaker clients are mocked at the module boundary; commands are
// captured as plain objects so the tests pin the wire contract: which keys
// are read/written, the manifest shape for multi-image v2, and the invoke's
// InputLocation.

const s3Send = vi.fn();
const smSend = vi.fn();

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    region: string;
    constructor(cfg: { region: string }) {
      this.region = cfg.region;
    }
    send = (...args: unknown[]) => s3Send(...args);
  },
  CopyObjectCommand: class {
    constructor(public readonly input: Record<string, unknown>) {}
  },
  GetObjectCommand: class {
    constructor(public readonly input: Record<string, unknown>) {}
  },
  PutObjectCommand: class {
    constructor(public readonly input: Record<string, unknown>) {}
  },
}));

vi.mock('@aws-sdk/client-sagemaker-runtime', () => ({
  SageMakerRuntimeClient: class {
    send = (...args: unknown[]) => smSend(...args);
  },
  InvokeEndpointAsyncCommand: class {
    constructor(public readonly input: Record<string, unknown>) {}
  },
}));

import { dispatchToRegion, type EndpointConfig } from './sagemaker.js';
import type { TaskRecord } from './types.js';

const CONF: EndpointConfig = {
  region: 'us-east-2',
  instanceType: 'g6e',
  endpointName: 'svc-sagemaker-pixal3d-g6e',
  inputBucket: 'in-pixal-use2',
  variantName: 'pixal3d',
};

const baseTask = {
  task_id: '01JMV',
  artifact_prefix: 'tasks/01JMV',
  input: {},
} as unknown as TaskRecord;

beforeEach(() => {
  s3Send.mockReset();
  smSend.mockReset().mockResolvedValue({});
  process.env.WORK_BUCKET = 'work-bucket-test';
});

describe('dispatchToRegion', () => {
  it('single-image: copies tasks/{id}/input/0 to input.png and invokes the raw-body location', async () => {
    await dispatchToRegion(baseTask, CONF);

    expect(s3Send).toHaveBeenCalledTimes(1);
    const copy = s3Send.mock.calls[0]![0]!.input as Record<string, unknown>;
    expect(copy).toEqual({
      Bucket: 'in-pixal-use2',
      Key: 'tasks/01JMV/input.png',
      CopySource: 'work-bucket-test/tasks/01JMV/input/0',
      ContentType: 'image/png',
      MetadataDirective: 'REPLACE',
    });
    expect(smSend).toHaveBeenCalledTimes(1);
    expect(smSend.mock.calls[0]![0]!.input).toEqual({
      EndpointName: 'svc-sagemaker-pixal3d-g6e',
      InputLocation: 's3://in-pixal-use2/tasks/01JMV/input.png',
      InferenceId: '01JMV',
      InvocationTimeoutSeconds: 3600,
    });
  });

  it('multi-image multiview: reads every staged view, writes the manifest, invokes input.json', async () => {
    s3Send.mockImplementation(async (cmd: { input: Record<string, unknown> }) => {
      // PutObject (carries Body) -> {}; GetObject -> fake image bytes.
      if ('Body' in cmd.input) return {};
      return { Body: { transformToByteArray: async () => new Uint8Array([0xab, 0xcd]) } };
    });
    const task = {
      ...baseTask,
      input: { image_urls: ['https://a/1.png', 'https://a/2.png', 'https://a/3.png'] },
    } as TaskRecord;

    await dispatchToRegion(task, CONF, true);

    // GetObject x3 from the WORK bucket, then one PutObject.
    const gets = s3Send.mock.calls
      .map((c) => c[0]!.input as Record<string, unknown>)
      .filter((i) => !('Body' in i) && !('CopySource' in i));
    expect(gets).toEqual([
      { Bucket: 'work-bucket-test', Key: 'tasks/01JMV/input/0' },
      { Bucket: 'work-bucket-test', Key: 'tasks/01JMV/input/1' },
      { Bucket: 'work-bucket-test', Key: 'tasks/01JMV/input/2' },
    ]);
    const put = s3Send.mock.calls
      .map((c) => c[0]!.input as Record<string, unknown>)
      .find((i) => i.ContentType === 'application/json')!;
    expect(put.Bucket).toBe('in-pixal-use2');
    expect(put.Key).toBe('tasks/01JMV/input.json');
    const manifest = JSON.parse(put.Body as string);
    expect(manifest).toEqual({
      images: ['q80=', 'q80=', 'q80='],
      azimuths_deg: [90, 180], // default: 90 * (i + 1) per extra image
    });
    expect(smSend.mock.calls[0]![0]!.input).toMatchObject({
      InputLocation: 's3://in-pixal-use2/tasks/01JMV/input.json',
      InferenceId: '01JMV',
    });
  });

  it('multi-image multiview: honors explicit view_azimuths_deg', async () => {
    s3Send.mockResolvedValue({ Body: { transformToByteArray: async () => new Uint8Array([1]) } });
    const task = {
      ...baseTask,
      input: {
        image_urls: ['https://a/1.png', 'https://a/2.png'],
        view_azimuths_deg: [250],
      },
    } as TaskRecord;

    await dispatchToRegion(task, CONF, true);

    const put = s3Send.mock.calls
      .map((c) => c[0]!.input as Record<string, unknown>)
      .find((i) => i.ContentType === 'application/json')!;
    expect(JSON.parse(put.Body as string).azimuths_deg).toEqual([250]);
  });

  it('multi-image WITHOUT the multiview flag keeps the single-image path (v1 chain)', async () => {
    const task = {
      ...baseTask,
      input: { image_urls: ['https://a/1.png', 'https://a/2.png'] },
    } as TaskRecord;

    await dispatchToRegion(task, CONF, false);

    const copy = s3Send.mock.calls[0]![0]!.input as Record<string, unknown>;
    expect(copy.Key).toBe('tasks/01JMV/input.png');
    expect(smSend.mock.calls[0]![0]!.input).toMatchObject({
      InputLocation: 's3://in-pixal-use2/tasks/01JMV/input.png',
    });
  });

  it('single-image task on the multiview chain stays raw-body (MV V=1)', async () => {
    const task = { ...baseTask, input: { image_urls: ['https://a/1.png'] } } as TaskRecord;
    await dispatchToRegion(task, CONF, true);
    const copy = s3Send.mock.calls[0]![0]!.input as Record<string, unknown>;
    expect(copy.Key).toBe('tasks/01JMV/input.png');
  });

  it('throws when a staged view is missing from the work bucket', async () => {
    s3Send.mockResolvedValue({}); // no Body
    const task = {
      ...baseTask,
      input: { image_urls: ['https://a/1.png', 'https://a/2.png'] },
    } as TaskRecord;

    await expect(dispatchToRegion(task, CONF, true)).rejects.toThrow(/missing staged input/);
    expect(smSend).not.toHaveBeenCalled();
  });
});
