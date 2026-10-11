import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  host: process.env.S3_HOST || 'minio',
  port: parseInt(process.env.S3_PORT || '9000', 10),
  region: process.env.S3_REGION || 'us-east-1',
  accessKey: process.env.S3_ACCESS_KEY!,
  secretKey: process.env.S3_SECRET_KEY!,
  videosBucket: process.env.S3_VIDEOS_BUCKET || 'streamtube-videos',
  thumbnailsBucket:
    process.env.S3_THUMBNAILS_BUCKET || 'streamtube-thumbnails',
  presignExpirySeconds: parseInt(
    process.env.S3_PRESIGN_EXPIRY_SECONDS || '3600',
    10,
  ),
}));
