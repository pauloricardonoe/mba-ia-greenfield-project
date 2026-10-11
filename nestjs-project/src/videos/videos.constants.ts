export enum VideoStatus {
  DRAFT = 'draft',
  PROCESSING = 'processing',
  READY = 'ready',
  ERROR = 'error',
}

export const VIDEO_QUEUE = 'video-processing' as const;

/** S3 single-object PUT is capped at 5 GiB; the phase caps uploads at 10 GiB. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024;

/** Target part size (TD-02: 100–200 MB parts → ~50–100 parts for 10 GB). */
export const UPLOAD_PART_SIZE = 100 * 1024 * 1024;

/** S3 multipart uploads are limited to 10 000 parts. */
export const MAX_UPLOAD_PARTS = 10000;
