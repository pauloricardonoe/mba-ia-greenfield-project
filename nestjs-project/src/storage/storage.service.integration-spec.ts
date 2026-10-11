import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import {
  DeleteBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const videosBucket =
  process.env.S3_VIDEOS_BUCKET ?? 'streamtube-videos';
const thumbnailsBucket =
  process.env.S3_THUMBNAILS_BUCKET ?? 'streamtube-thumbnails';

function createVerificationClient(): S3Client {
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

describe('StorageService (integration)', () => {
  let module: TestingModule;
  let storageService: StorageService;
  let client: S3Client;

  const createdKeys: string[] = [];

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    storageService = module.get(StorageService);
    client = createVerificationClient();
  });

  afterAll(async () => {
    await Promise.all(
      createdKeys.map((key) =>
        client
          .send(
            new DeleteObjectCommand({ Bucket: videosBucket, Key: key }),
          )
          .catch(() => undefined),
      ),
    );
    client.destroy();
    await module.close();
  });

  async function putObject(body: string): Promise<string> {
    const key = `videos/get-${randomUUID()}.bin`;
    await client.send(
      new PutObjectCommand({ Bucket: videosBucket, Key: key, Body: body }),
    );
    createdKeys.push(key);
    return key;
  }

  it('should create missing buckets and be idempotent', async () => {
    // Remove the buckets (empty at this point) so the create path is exercised.
    await deleteBucketIfExists(client, videosBucket);
    await deleteBucketIfExists(client, thumbnailsBucket);

    await expect(storageService.ensureBuckets()).resolves.toBeUndefined();
    await expect(headBucket(client, videosBucket)).resolves.toBeUndefined();
    await expect(headBucket(client, thumbnailsBucket)).resolves.toBeUndefined();

    // Idempotent: running again is a no-op.
    await expect(storageService.ensureBuckets()).resolves.toBeUndefined();
  });

  it('should start a multipart upload and accept a presigned part PUT', async () => {
    const key = `videos/multipart-${randomUUID()}.bin`;
    createdKeys.push(key);

    const uploadId = await storageService.createMultipartUpload(key);
    expect(uploadId).toBeTruthy();

    const partNumber = 1;
    const url = await storageService.presignUploadPart(
      key,
      uploadId,
      partNumber,
    );

    const body = Buffer.from('multipart payload');
    const response = await fetch(url, { method: 'PUT', body });
    expect(response.status).toBe(200);

    const eTag = response.headers.get('etag');
    expect(eTag).toBeTruthy();

    await storageService.completeMultipartUpload(key, uploadId, [
      { partNumber, eTag: eTag! },
    ]);

    const head = await client.send(
      new HeadObjectCommand({ Bucket: videosBucket, Key: key }),
    );
    expect(head.ContentLength).toBe(body.length);
  });

  it('should presign a GET URL that serves the object', async () => {
    const body = 'streamtube test object';
    const key = await putObject(body);

    const url = await storageService.presignGetObject(key);

    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(body);
  });

  it('should serve 206 Partial Content when the presigned GET carries a Range header', async () => {
    const body = 'streamtube test object';
    const key = await putObject(body);

    const url = await storageService.presignGetObject(key);

    const response = await fetch(url, { headers: { Range: 'bytes=0-4' } });
    expect(response.status).toBe(206);
    expect(await response.text()).toBe(body.slice(0, 5));
  });

  it('should presign a download URL with an attachment disposition', async () => {
    const key = await putObject('streamtube test object');

    const url = await storageService.presignGetObject(key, { download: true });

    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('attachment');
  });
});

async function headBucket(client: S3Client, bucket: string): Promise<void> {
  await client.send(new HeadBucketCommand({ Bucket: bucket }));
}

async function deleteBucketIfExists(
  client: S3Client,
  bucket: string,
): Promise<void> {
  await client
    .send(new DeleteBucketCommand({ Bucket: bucket }))
    .catch(() => undefined);
}
