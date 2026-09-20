import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { requireEnv } from './env.js';

const s3 = new S3Client({});

/** Max decoded bytes for one inline data-URI image. Transport-bound:
 *  6 MB Lambda sync-invocation request cap, base64 inflates x4/3. */
export const MAX_INLINE_IMAGE_BYTES = 4_194_304; // 4 MiB

/** Max decoded bytes prepare will fetch from a remote https image.
 *  Protects prepare's Buffer.from(await response.arrayBuffer()) on its
 *  256 MB Lambda; independent of the inline cap. */
export const MAX_FETCH_IMAGE_BYTES = 26_214_400; // 25 MiB

export const DATA_URI_RE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/;

export function isDataUri(url: string): boolean {
  return url.startsWith('data:');
}

/**
 * Decode one already-validated data:image URI and upload it to the work
 * bucket. Returns the durable s3:// URL that replaces it in input.image_urls.
 */
export async function offloadDataUri(dataUri: string, key: string): Promise<string> {
  const match = DATA_URI_RE.exec(dataUri);
  if (!match) {
    throw new Error('data URI must be base64 with media type image/png, image/jpeg, or image/webp');
  }
  const base64 = match[2]!;
  if ((base64.length * 3) / 4 > MAX_INLINE_IMAGE_BYTES) {
    throw new Error(`data URI exceeds the ${MAX_INLINE_IMAGE_BYTES} byte image limit`);
  }
  const bucket = requireEnv('WORK_BUCKET');
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: Buffer.from(base64, 'base64'),
      ContentType: `image/${match[1]}`,
    }),
  );
  return `s3://${bucket}/${key}`;
}
