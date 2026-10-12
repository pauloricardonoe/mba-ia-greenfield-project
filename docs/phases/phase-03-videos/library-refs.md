---
libs:
  bullmq:
    version: "^6.3.11"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-10-03T14:05:00-03:00"
  "@nestjs/bullmq":
    version: "^11.0.5"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-10-03T14:05:00-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1146.0"
    context7_id: "unresolved — context7 unavailable at fetch time; version verified via npm registry, API via AWS SDK v3 docs"
    fetched_at: "2026-10-11T14:28:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1146.0"
    context7_id: "unresolved — context7 unavailable at fetch time; version verified via npm registry"
    fetched_at: "2026-10-11T14:28:00-03:00"
  fluent-ffmpeg:
    version: "^2.1.3"
    context7_id: "/fluent-ffmpeg/node-fluent-ffmpeg"
    fetched_at: "2026-10-03T14:05:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-11T14:28:11-0300"
---

# phase-03-videos — Library References

Distilled docs for libraries decided in this slice. Pulled via Context7 (BullMQ, `@nestjs/bullmq`, `fluent-ffmpeg`); the AWS SDK entries were verified against the npm registry and the official AWS SDK v3 documentation because the Context7 MCP server was unavailable at fetch time. Re-fetch when the underlying TD changes.

Version compatibility note: `@nestjs/bullmq@11.0.5` declares peer deps `bullmq: ^3 || ^4 || ^5 || ^6` and `@nestjs/common|core: ^10 || ^11` — the pinned `bullmq@^6` + NestJS 11 combination is supported.

---

## bullmq

**Source:** `/taskforcesh/bullmq` (Context7) — High reputation, 1719 snippets, benchmark 88.92. Maps to `phase-03-videos/TD-01` Decision A.

### Queue + Worker + connection

BullMQ uses `ioredis` under the hood; connection options are forwarded to it. Inside Compose, the host is the **service name** (`redis`), never `localhost`.

```typescript
import { Queue, Worker } from 'bullmq';

const connection = { host: process.env.REDIS_HOST ?? 'redis', port: Number(process.env.REDIS_PORT ?? 6379) };

const videoQueue = new Queue('video-processing', { connection });

const worker = new Worker(
  'video-processing',
  async (job) => {
    // job.data = { videoId, storageKey }
  },
  { connection, concurrency: 2 },
);
```

### Retries / backoff (drives TD-06 status lifecycle)

```typescript
await videoQueue.add(
  'process',
  { videoId },
  { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
);
```

- When `attempts` are exhausted the job moves to the **failed** set — the worker's `failed` event is where the video status is flipped to `error` (TD-06).
- `Worker` and `QueueEvents` open **duplicated** connections internally, so the Redis client/adapter must support `duplicate()` (ioredis does).
- For a reused `ioredis` instance with a `Worker`, set `maxRetriesPerRequest: null` so the blocking commands retry indefinitely across reconnections.

---

## @nestjs/bullmq

**Source:** `/nestjs/bull` (Context7) — High reputation, 316 snippets, benchmark 83.44. Maps to `phase-03-videos/TD-01` (producer) and `phase-03-videos/TD-04` (consumer).

### Install

```bash
npm i --save @nestjs/bullmq bullmq
```

### Root config (async, from namespaced config)

```typescript
import { BullModule } from '@nestjs/bullmq';

@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: (config: ConfigService) => ({
        connection: { host: config.get('redis.host'), port: config.get('redis.port') },
      }),
      inject: [ConfigService],
    }),
  ],
})
export class AppModule {}
```

### Register a queue + consume jobs

```typescript
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

// in the videos module
BullModule.registerQueue({ name: 'video-processing' });

@Processor('video-processing', { concurrency: 2 })
export class VideoProcessor extends WorkerHost {
  async process(job: Job<{ videoId: string }>): Promise<void> {
    // probe metadata + generate thumbnail + update DB status
  }
}
```

- `@Processor(queueName, workerOptions)` + `WorkerHost.process(job)` is the consumer contract; `workerOptions` accepts raw BullMQ `WorkerOptions` (`concurrency`, `limiter`, …).
- The **worker container** (TD-04) boots a Nest application context that registers only the consumer side (no HTTP server).

---

## @aws-sdk/client-s3 (+ @aws-sdk/s3-request-presigner)

**Source:** AWS SDK v3 (verified via npm registry; official docs). Maps to `phase-03-videos/TD-03` Decision A, and underpins TD-02 (multipart presign) and TD-08 (presigned GET + Range).

### Client pointed at MinIO (S3-compatible)

```typescript
import { S3Client } from '@aws-sdk/client-s3';

export const s3 = new S3Client({
  region: process.env.S3_REGION ?? 'us-east-1',
  endpoint: `http://${process.env.S3_HOST ?? 'minio'}:${process.env.S3_PORT ?? 9000}`,
  forcePathStyle: true,          // required for MinIO path-style addressing
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY!,
    secretAccessKey: process.env.S3_SECRET_KEY!,
  },
});
```

### Presigned multipart (TD-02 — 10GB upload)

The S3 single-object `PutObject` limit is **5GB**, so 10GB must be multipart:

```typescript
import { CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// 1) API starts the upload
const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket: 'streamtube-videos', Key: key }));

// 2) API returns one presigned PUT URL per part (client uploads parts directly to MinIO)
const url = await getSignedUrl(s3, new UploadPartCommand({ Bucket, Key: key, UploadId, PartNumber: n }), { expiresIn: 3600 });

// 3) API completes after the client reports the ETags
await s3.send(new CompleteMultipartUploadCommand({ Bucket, Key: key, UploadId, MultipartUpload: { Parts } }));
```

### Presigned GET with Range (TD-08 — streaming/download)

Presigned GET URLs natively support HTTP `Range` → `206 Partial Content` (the player sends the `Range` header to MinIO). Download is the same URL with a disposition override:

```typescript
const streamUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket, Key: key }), { expiresIn: 3600 });
const downloadUrl = await getSignedUrl(
  s3,
  new GetObjectCommand({ Bucket, Key: key, ResponseContentDisposition: `attachment; filename="${filename}"` }),
  { expiresIn: 3600 },
);
```

- Buckets `streamtube-videos` / `streamtube-thumbnails` are ensured on API startup (`HeadBucket` → `CreateBucket` if missing).

---

## fluent-ffmpeg

**Source:** `/fluent-ffmpeg/node-fluent-ffmpeg` (Context7) — Medium reputation, 340 snippets, benchmark 84.24. Maps to `phase-03-videos/TD-05` Decision A. Requires the `ffmpeg`/`ffprobe` binaries on the host — installed via apt in the worker image.

### Metadata (duration/format) via ffprobe

```typescript
import ffmpeg from 'fluent-ffmpeg';

ffmpeg.ffprobe('/tmp/source.mp4', (err, data) => {
  const durationSeconds = data.format.duration;      // TD-06 metadata
  const videoStream = data.streams.find((s) => s.codec_type === 'video');
  // width/height/codec from videoStream
});
```

### Thumbnail from a frame

```typescript
ffmpeg('/tmp/source.mp4')
  .screenshots({ count: 1, timemarks: ['10%'], filename: 'thumb.jpg', folder: '/tmp' })
  .on('filenames', (names) => { /* names[0] = generated thumbnail */ })
  .on('error', (err) => { /* → job failure → status error (TD-06) */ });
```

- Percentage timemarks require a **file path** (not a stream) and trigger an internal ffprobe to resolve the duration.
- The worker downloads the source object to a temp path, probes/thumbnails, uploads the thumbnail to the `streamtube-thumbnails` bucket, updates the video row, then deletes the temp files.
