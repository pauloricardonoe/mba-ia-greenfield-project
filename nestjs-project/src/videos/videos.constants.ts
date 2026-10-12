export enum VideoStatus {
  DRAFT = 'draft',
  PROCESSING = 'processing',
  READY = 'ready',
  ERROR = 'error',
}

import type { JobsOptions } from 'bullmq';

export const VIDEO_QUEUE = 'video-processing' as const;

export const VIDEO_JOB_NAME = 'process' as const;

/** TD-06: at-least-once with 3 attempts and exponential backoff. */
export const VIDEO_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
};

/** S3 single-object PUT is capped at 5 GiB; the phase caps uploads at 10 GiB. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024;

/** Target part size (TD-02: 100–200 MB parts → ~50–100 parts for 10 GB). */
export const UPLOAD_PART_SIZE = 100 * 1024 * 1024;

/** S3 multipart uploads are limited to 10 000 parts. */
export const MAX_UPLOAD_PARTS = 10000;

/** Payload of the `video.processing.requested` job. */
export interface VideoJobData {
  videoId: string;
  sourceKey: string;
}
