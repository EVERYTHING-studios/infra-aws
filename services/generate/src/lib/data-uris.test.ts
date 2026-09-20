import { describe, expect, it, vi, beforeEach } from 'vitest';

const send = vi.fn();
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = (...args: unknown[]) => send(...args);
  },
  PutObjectCommand: class {
    constructor(public readonly input: unknown) {}
  },
}));

import { offloadDataUri, MAX_INLINE_IMAGE_BYTES } from './data-uris.js';

// 1x1 transparent PNG.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue({});
  process.env.WORK_BUCKET = 'work-bucket-test';
});

describe('offloadDataUri', () => {
  it('uploads decoded bytes and returns the durable s3:// URL', async () => {
    const url = await offloadDataUri(`data:image/png;base64,${PNG_B64}`, 'tasks/t/uploads/0');

    expect(url).toBe('s3://work-bucket-test/tasks/t/uploads/0');
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]![0];
    expect(command.input).toMatchObject({
      Bucket: 'work-bucket-test',
      Key: 'tasks/t/uploads/0',
      ContentType: 'image/png',
    });
    expect(command.input.Body).toEqual(Buffer.from(PNG_B64, 'base64'));
  });

  it('rejects unsupported media types', async () => {
    await expect(
      offloadDataUri(`data:image/gif;base64,${PNG_B64}`, 'tasks/t/uploads/0'),
    ).rejects.toThrow(/image\/png, image\/jpeg, or image\/webp/);
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects non-base64 payloads', async () => {
    await expect(
      offloadDataUri('data:image/png;base64,not%20base64!', 'tasks/t/uploads/0'),
    ).rejects.toThrow(/base64/);
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects payloads over the inline byte cap', async () => {
    // Padding-free 'A's: length*3/4 is exact decoded size.
    const oversized = 'A'.repeat(((MAX_INLINE_IMAGE_BYTES + 1) * 4) / 3);
    await expect(
      offloadDataUri(`data:image/png;base64,${oversized}`, 'tasks/t/uploads/0'),
    ).rejects.toThrow(/byte image limit/);
    expect(send).not.toHaveBeenCalled();
  });
});
