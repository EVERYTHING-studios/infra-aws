import { describe, expect, it } from 'vitest';
import { validateCreateJob, validateCreateTask, ValidationError } from './validate.js';

const OUTPUT = {
  user_id: '11111111-2222-4333-8444-555555555555',
  job_id: '99999999-8888-4777-8666-555555555555',
};

// 1x1 transparent PNG.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('validateCreateTask', () => {
  it('accepts a valid text-to-3d-preview request', () => {
    const result = validateCreateTask({
      type: 'text-to-3d-preview',
      input: { prompt: 'a teapot' },
      output: OUTPUT,
    });
    expect(result.type).toBe('text-to-3d-preview');
    expect(result.input.prompt).toBe('a teapot');
    expect(result.output).toEqual(OUTPUT);
  });

  it('rejects unknown task types', () => {
    expect(() => validateCreateTask({ type: '3d-magic', input: {}, output: OUTPUT })).toThrow(
      ValidationError,
    );
  });

  it('requires a prompt for text-to-3d-preview', () => {
    expect(() =>
      validateCreateTask({ type: 'text-to-3d-preview', input: {}, output: OUTPUT }),
    ).toThrow(/prompt/);
  });

  it('rejects prompts over the length limit', () => {
    expect(() =>
      validateCreateTask({
        type: 'text-to-3d-preview',
        input: { prompt: 'x'.repeat(601) },
        output: OUTPUT,
      }),
    ).toThrow(/600/);
  });

  it('requires preview_task_id for refine and allows omitting output', () => {
    const result = validateCreateTask({
      type: 'text-to-3d-refine',
      input: { preview_task_id: '01JABCDEF' },
    });
    expect(result.output).toBeUndefined();

    expect(() => validateCreateTask({ type: 'text-to-3d-refine', input: {} })).toThrow(
      /preview_task_id/,
    );
  });

  it('validates output when provided on refine', () => {
    expect(() =>
      validateCreateTask({
        type: 'text-to-3d-refine',
        input: { preview_task_id: '01JABCDEF' },
        output: { user_id: 'nope', job_id: OUTPUT.job_id },
      }),
    ).toThrow(/user_id/);
  });

  it('requires exactly one image for image-to-3d', () => {
    expect(() =>
      validateCreateTask({
        type: 'image-to-3d',
        input: { image_urls: ['https://a.example/1.png', 'https://a.example/2.png'] },
        output: OUTPUT,
      }),
    ).toThrow(/exactly one/);
  });

  it('caps multi-image-to-3d at 4 images and validates URLs', () => {
    expect(() =>
      validateCreateTask({
        type: 'multi-image-to-3d',
        input: { image_urls: Array(5).fill('https://a.example/x.png') },
        output: OUTPUT,
      }),
    ).toThrow(/at most 4/);

    expect(() =>
      validateCreateTask({
        type: 'multi-image-to-3d',
        input: { image_urls: ['not a url'] },
        output: OUTPUT,
      }),
    ).toThrow(/valid URL/);
  });

  it('requires UUID output hints for non-refine types', () => {
    expect(() =>
      validateCreateTask({ type: 'text-to-3d-preview', input: { prompt: 'x' } }),
    ).toThrow(/output/);

    expect(() =>
      validateCreateTask({
        type: 'text-to-3d-preview',
        input: { prompt: 'x' },
        output: { user_id: OUTPUT.user_id, job_id: '123' },
      }),
    ).toThrow(/job_id/);
  });

  it('bounds the idempotency key', () => {
    expect(() =>
      validateCreateTask({
        type: 'text-to-3d-preview',
        input: { prompt: 'x' },
        output: OUTPUT,
        idempotency_key: 'k'.repeat(257),
      }),
    ).toThrow(/idempotency_key/);
  });
});

describe('validateCreateJob', () => {
  it('accepts a valid job without output hints', () => {
    const result = validateCreateJob({
      type: 'text-to-3d-preview',
      input: { prompt: 'a teapot' },
      idempotency_key: 'k1',
    });
    expect(result.type).toBe('text-to-3d-preview');
    expect(result.input.prompt).toBe('a teapot');
    expect(result.idempotency_key).toBe('k1');
    expect(result).not.toHaveProperty('output');
  });

  it('rejects an output field outright', () => {
    expect(() =>
      validateCreateJob({
        type: 'text-to-3d-preview',
        input: { prompt: 'a teapot' },
        output: OUTPUT,
      }),
    ).toThrow(/output is not accepted/);
  });

  it('rejects unknown job types', () => {
    expect(() => validateCreateJob({ type: '3d-magic', input: {} })).toThrow(ValidationError);
  });

  it('requires preview_task_id for refine jobs', () => {
    expect(() => validateCreateJob({ type: 'text-to-3d-refine', input: {} })).toThrow(
      /preview_task_id/,
    );
  });

  it('bounds the idempotency key with the same rule as the task endpoint', () => {
    expect(() =>
      validateCreateJob({
        type: 'text-to-3d-preview',
        input: { prompt: 'x' },
        idempotency_key: 'k'.repeat(257),
      }),
    ).toThrow(/idempotency_key/);
  });

  it('accepts a valid png data URI on jobs', () => {
    const dataUri = `data:image/png;base64,${PNG_B64}`;
    const result = validateCreateJob({
      type: 'image-to-3d',
      input: { image_urls: [dataUri] },
    });
    expect(result.input.image_urls).toEqual([dataUri]);
  });

  it('rejects data URIs with an unsupported media type', () => {
    expect(() =>
      validateCreateJob({
        type: 'image-to-3d',
        input: { image_urls: [`data:image/gif;base64,${PNG_B64}`] },
      }),
    ).toThrow(/data URIs must be base64/);
  });

  it('rejects data URIs over the inline byte cap', () => {
    const oversized = 'A'.repeat(((4_194_304 + 1) * 4) / 3);
    expect(() =>
      validateCreateJob({
        type: 'image-to-3d',
        input: { image_urls: [`data:image/png;base64,${oversized}`] },
      }),
    ).toThrow(/4194304/);
  });

  it('still rejects data URIs on the task endpoint (jobs-only feature)', () => {
    expect(() =>
      validateCreateTask({
        type: 'image-to-3d',
        input: { image_urls: [`data:image/png;base64,${PNG_B64}`] },
        output: OUTPUT,
      }),
    ).toThrow(/http\(s\) URL/);
  });
});
