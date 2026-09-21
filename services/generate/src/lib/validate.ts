import {
  CreateJobRequest,
  CreateTaskRequest,
  TASK_TYPES,
  TaskType,
} from './types.js';
import { DATA_URI_RE, MAX_INLINE_IMAGE_BYTES } from './data-uris.js';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PROMPT_LENGTH = 600;
const MAX_IMAGES = 4;

function assertHttpUrl(value: string, field: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ValidationError(`${field} is not a valid URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ValidationError(`${field} must be an http(s) URL`);
  }
}

function assertDataImageUri(value: string, field: string): void {
  const match = DATA_URI_RE.exec(value);
  if (!match) {
    throw new ValidationError(
      `${field} data URIs must be base64 with media type image/png, image/jpeg, or image/webp`,
    );
  }
  if ((match[2]!.length * 3) / 4 > MAX_INLINE_IMAGE_BYTES) {
    throw new ValidationError(
      `${field} data URI exceeds the ${MAX_INLINE_IMAGE_BYTES} byte image limit`,
    );
  }
}

/** Per-type input validation shared by the web-app task and customer job endpoints. */
function validateTaskInput(type: TaskType, input: Record<string, unknown>, allowDataUris: boolean = false): void {
  switch (type) {
    case 'text-to-3d-preview': {
      if (typeof input.prompt !== 'string' || input.prompt.trim().length === 0) {
        throw new ValidationError('input.prompt is required for text-to-3d-preview');
      }
      if (input.prompt.length > MAX_PROMPT_LENGTH) {
        throw new ValidationError(`input.prompt must be at most ${MAX_PROMPT_LENGTH} characters`);
      }
      break;
    }
    case 'text-to-3d-refine': {
      if (typeof input.preview_task_id !== 'string' || input.preview_task_id.length === 0) {
        throw new ValidationError('input.preview_task_id is required for text-to-3d-refine');
      }
      break;
    }
    case 'image-to-3d':
    case 'multi-image-to-3d': {
      const urls = input.image_urls;
      if (!Array.isArray(urls) || urls.length === 0) {
        throw new ValidationError(`input.image_urls is required for ${type}`);
      }
      if (type === 'image-to-3d' && urls.length !== 1) {
        throw new ValidationError('image-to-3d takes exactly one image_url');
      }
      if (urls.length > MAX_IMAGES) {
        throw new ValidationError(`input.image_urls accepts at most ${MAX_IMAGES} images`);
      }
      for (const url of urls) {
        if (typeof url !== 'string') {
          throw new ValidationError('input.image_urls must be strings');
        }
        if (allowDataUris && url.startsWith('data:')) {
          assertDataImageUri(url, 'input.image_urls');
        } else {
          assertHttpUrl(url, 'input.image_urls');
        }
      }
      break;
    }
  }
}

/**
 * Validates and normalises a POST /v1/tasks body. Throws ValidationError with
 * a caller-safe message on any problem.
 */
export function validateCreateTask(body: unknown): CreateTaskRequest {
  if (typeof body !== 'object' || body === null) {
    throw new ValidationError('request body must be a JSON object');
  }
  const req = body as Record<string, unknown>;

  const type = req.type as TaskType;
  if (!TASK_TYPES.includes(type)) {
    throw new ValidationError(`type must be one of: ${TASK_TYPES.join(', ')}`);
  }

  const input = (req.input ?? {}) as Record<string, unknown>;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('input must be an object');
  }

  validateTaskInput(type, input);

  // Output hints are required for everything except refine (which inherits
  // them from its parent task).
  const output = req.output as Record<string, unknown> | undefined;
  if (type !== 'text-to-3d-refine' || output !== undefined) {
    if (typeof output !== 'object' || output === null) {
      throw new ValidationError('output.user_id and output.job_id are required');
    }
    for (const field of ['user_id', 'job_id'] as const) {
      const value = output[field];
      if (typeof value !== 'string' || !UUID_RE.test(value)) {
        throw new ValidationError(`output.${field} must be a UUID`);
      }
    }
  }

  const idempotencyKey = req.idempotency_key;
  if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0 || idempotencyKey.length > 256)) {
    throw new ValidationError('idempotency_key must be a non-empty string of at most 256 characters');
  }

  return {
    type,
    input: input as CreateTaskRequest['input'],
    options: (req.options ?? {}) as CreateTaskRequest['options'],
    output: output as CreateTaskRequest['output'],
    idempotency_key: idempotencyKey as string | undefined,
  };
}

/**
 * Validates and normalises a POST /v1/jobs body (customer API). Same input
 * rules as validateCreateTask, but `output` is rejected outright: customer
 * job destinations are synthesized server-side, never client-chosen.
 */
export function validateCreateJob(body: unknown): CreateJobRequest {
  if (typeof body !== 'object' || body === null) {
    throw new ValidationError('request body must be a JSON object');
  }
  const req = body as Record<string, unknown>;

  if (req.output !== undefined) {
    throw new ValidationError('output is not accepted on this endpoint');
  }

  const type = req.type as TaskType;
  if (!TASK_TYPES.includes(type)) {
    throw new ValidationError(`type must be one of: ${TASK_TYPES.join(', ')}`);
  }

  const input = (req.input ?? {}) as Record<string, unknown>;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('input must be an object');
  }

  validateTaskInput(type, input, true);

  const idempotencyKey = req.idempotency_key;
  if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0 || idempotencyKey.length > 256)) {
    throw new ValidationError('idempotency_key must be a non-empty string of at most 256 characters');
  }

  return {
    type,
    input: input as CreateJobRequest['input'],
    options: (req.options ?? {}) as CreateJobRequest['options'],
    idempotency_key: idempotencyKey as string | undefined,
  };
}
