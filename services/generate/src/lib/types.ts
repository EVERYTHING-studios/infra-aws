/**
 * Wire and storage types for the generate service.
 *
 * Status vocabulary intentionally matches what the web-app already stores in
 * `meshy_jobs.status` so its mapping layer stays trivial.
 */

export const TASK_TYPES = [
  'text-to-3d-preview',
  'text-to-3d-refine',
  'image-to-3d',
  'multi-image-to-3d',
] as const;

export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_STATUSES = [
  'PENDING',
  'QUEUED',
  'IN_PROGRESS',
  'SUCCEEDED',
  'FAILED',
  'CANCELED',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TERMINAL_STATUSES: readonly TaskStatus[] = ['SUCCEEDED', 'FAILED', 'CANCELED'];

export interface TaskInput {
  prompt?: string;
  negative_prompt?: string;
  image_urls?: string[];
  /** For text-to-3d-refine: the preview task whose geometry gets textured. */
  preview_task_id?: string;
}

export interface TaskOptions {
  art_style?: string;
  topology?: 'quad' | 'triangle';
  target_polycount?: number;
  enable_pbr?: boolean;
  should_texture?: boolean;
  symmetry_mode?: 'off' | 'auto' | 'on';
  texture_prompt?: string;
  /** Formats to emit beyond glb; post-process converts. */
  formats?: Array<'glb' | 'fbx' | 'obj' | 'usdz'>;
}

/** Where the finished assets land: the web-app's model-assets key convention. */
export interface TaskOutputHints {
  user_id: string;
  job_id: string;
}

export interface CreateTaskRequest {
  type: TaskType;
  input: TaskInput;
  options?: TaskOptions;
  output?: TaskOutputHints;
  idempotency_key?: string;
}

/** POST /v1/jobs body — customer API. No output hints: the destination is synthesized server-side. */
export interface CreateJobRequest {
  type: TaskType;
  input: TaskInput;
  options?: TaskOptions;
  idempotency_key?: string;
}

export interface ModelUrls {
  glb?: string;
  fbx?: string;
  obj?: string;
  usdz?: string;
}

export interface TaskError {
  code: string;
  message: string;
}

/** DynamoDB record (pk = TASK#{task_id}). */
export interface TaskRecord {
  task_id: string;
  type: TaskType;
  status: TaskStatus;
  progress: number;
  input: TaskInput;
  options: TaskOptions;
  user_id: string;
  job_id: string;
  /** Refine tasks link back to their preview task. */
  parent_task_id?: string;
  /** Work-bucket prefix holding intermediate artifacts (tasks/{task_id}). */
  artifact_prefix?: string;
  model_urls?: ModelUrls;
  thumbnail_url?: string;
  error?: TaskError;
  execution_arn?: string;
  /** Step Functions task token, set by the SageMaker dispatcher and consumed by the callback to resume the state machine. */
  sagemaker_task_token?: string;
  sagemaker_region?: string;
  inference_backend?: string;
  idempotency_key?: string;
  /** Origin of the task; absent = 'web-app' (legacy in-flight records). */
  source?: 'web-app' | 'api';
  /** When inference compute started/finished (SageMaker or stub) — usage-billing data. */
  inference_started_at?: string;
  inference_finished_at?: string;
  created_at: string;
  updated_at: string;
  finished_at?: string;
  /** Epoch seconds; DynamoDB TTL. */
  ttl: number;
}

/** Shape returned by GET /v1/tasks/{id}. */
export interface ApiTask {
  task_id: string;
  type: TaskType;
  status: TaskStatus;
  progress: number;
  model_urls: ModelUrls | null;
  thumbnail_url: string | null;
  error: TaskError | null;
  created_at: string;
  finished_at: string | null;
}

/** Payload delivered to webhook consumers (web-app and customer endpoints). */
export interface WebhookEvent {
  event: 'task.updated' | 'ping';
  event_id: string;
  user_id: string;
  task_id: string;
  type: TaskType;
  status: TaskStatus;
  progress: number;
  model_urls?: ModelUrls;
  thumbnail_url?: string;
  error?: TaskError;
  timestamp: string;
}
export function toApiTask(record: TaskRecord): ApiTask {
  return {
    task_id: record.task_id,
    type: record.type,
    status: record.status,
    progress: record.progress,
    model_urls: record.model_urls ?? null,
    thumbnail_url: record.thumbnail_url ?? null,
    error: record.error ?? null,
    created_at: record.created_at,
    finished_at: record.finished_at ?? null,
  };
}

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
