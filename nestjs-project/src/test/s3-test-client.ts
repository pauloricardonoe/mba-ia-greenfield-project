import { S3Client } from '@aws-sdk/client-s3';

export const TEST_VIDEOS_BUCKET =
  process.env.S3_VIDEOS_BUCKET ?? 'streamtube-videos';

export const TEST_THUMBNAILS_BUCKET =
  process.env.S3_THUMBNAILS_BUCKET ?? 'streamtube-thumbnails';

/**
 * S3 client used by tests to verify/clean up storage side effects without
 * going through the code under test. Mirrors `storage.config.ts` defaults.
 */
export function createS3TestClient(): S3Client {
  return new S3Client({
    region: process.env.S3_REGION ?? 'us-east-1',
    endpoint: `http://${process.env.S3_HOST ?? 'minio'}:${process.env.S3_PORT ?? 9000}`,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY ?? '',
      secretAccessKey: process.env.S3_SECRET_KEY ?? '',
    },
  });
}
