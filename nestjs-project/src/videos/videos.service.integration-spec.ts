import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import {
  createS3TestClient,
  TEST_THUMBNAILS_BUCKET as thumbnailsBucket,
  TEST_VIDEOS_BUCKET as videosBucket,
} from '../test/s3-test-client';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import {
  InvalidUploadPartsException,
  UploadNotInitiatedException,
  VideoNotDraftException,
  VideoNotFoundException,
  VideoNotReadyException,
  VideoTooLargeException,
} from './exceptions/video.exception';
import {
  MAX_UPLOAD_BYTES,
  UPLOAD_PART_SIZE,
  VIDEO_QUEUE,
  VideoStatus,
  type VideoJobData,
} from './videos.constants';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

describe('VideosService (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let videosService: VideosService;
  let storageService: StorageService;
  let queue: Queue<VideoJobData>;
  let client: S3Client;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  const openUploads: { key: string; uploadId: string }[] = [];
  const createdObjects: string[] = [];
  const createdThumbnails: string[] = [];

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        // StorageModule is @Global and registered by AppModule in the app.
        StorageModule,
        VideosModule,
      ],
    }).compile();

    dataSource = module.get(DataSource);
    videosService = module.get(VideosService);
    storageService = module.get(StorageService);
    queue = module.get<Queue<VideoJobData>>(getQueueToken(VIDEO_QUEUE));
    client = createS3TestClient();

    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);

    await storageService.ensureBuckets();
  });

  afterAll(async () => {
    await Promise.all([
      ...openUploads.map(({ key, uploadId }) =>
        client
          .send(
            new AbortMultipartUploadCommand({
              Bucket: videosBucket,
              Key: key,
              UploadId: uploadId,
            }),
          )
          .catch(() => undefined),
      ),
      ...createdObjects.map((key) =>
        client
          .send(new DeleteObjectCommand({ Bucket: videosBucket, Key: key }))
          .catch(() => undefined),
      ),
      ...createdThumbnails.map((key) =>
        client
          .send(new DeleteObjectCommand({ Bucket: thumbnailsBucket, Key: key }))
          .catch(() => undefined),
      ),
    ]);
    client.destroy();
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.drain();
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `videos_service_${n}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${n}`,
        nickname: `videosvc${n}`,
        user_id: user.id,
      }),
    );
  }

  it('should persist a draft owned by the channel', async () => {
    const channel = await createChannel();

    const draft = await videosService.createDraft(channel.id, 'My first video');

    expect(draft.id).toBeDefined();
    expect(draft.status).toBe(VideoStatus.DRAFT);
    expect(draft.title).toBe('My first video');
    expect(draft.source_key).toMatch(
      new RegExp(`^videos/${draft.id}/[0-9a-f-]+\\.mp4$`),
    );

    const persisted = await videoRepository.findOneByOrFail({ id: draft.id });
    expect(persisted.channel_id).toBe(channel.id);
  });

  it('should start a multipart upload and return a part URL MinIO accepts', async () => {
    const channel = await createChannel();
    const draft = await videosService.createDraft(channel.id, 'Upload me');

    const result = await videosService.startUpload(draft.id, channel.id, 1024);
    openUploads.push({ key: result.key, uploadId: result.uploadId });

    expect(result.uploadId).toBeTruthy();
    expect(result.key).toBe(draft.source_key);
    expect(result.partSize).toBe(UPLOAD_PART_SIZE);
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0].partNumber).toBe(1);

    const response = await fetch(result.parts[0].url, {
      method: 'PUT',
      body: Buffer.from('part payload'),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBeTruthy();
  });

  it('should size parts so a 10 GiB upload stays within the S3 part limit', async () => {
    const channel = await createChannel();
    const draft = await videosService.createDraft(channel.id, 'Huge video');

    const result = await videosService.startUpload(
      draft.id,
      channel.id,
      MAX_UPLOAD_BYTES,
    );
    openUploads.push({ key: result.key, uploadId: result.uploadId });

    expect(result.partSize).toBe(UPLOAD_PART_SIZE);
    expect(result.parts).toHaveLength(
      Math.ceil(MAX_UPLOAD_BYTES / UPLOAD_PART_SIZE),
    );
    expect(result.parts).toHaveLength(103);
  });

  it('should reject an upload larger than 10 GiB', async () => {
    const channel = await createChannel();
    const draft = await videosService.createDraft(channel.id, 'Too big');

    await expect(
      videosService.startUpload(draft.id, channel.id, MAX_UPLOAD_BYTES + 1),
    ).rejects.toThrow(VideoTooLargeException);
  });

  it('should reject an upload for a video that is not a draft', async () => {
    const channel = await createChannel();
    const draft = await videosService.createDraft(channel.id, 'Processing');
    await videoRepository.update(draft.id, {
      status: VideoStatus.PROCESSING,
    });

    await expect(
      videosService.startUpload(draft.id, channel.id, 1024),
    ).rejects.toThrow(VideoNotDraftException);
  });

  it("should reject an upload for another channel's video", async () => {
    const owner = await createChannel();
    const stranger = await createChannel();
    const draft = await videosService.createDraft(owner.id, 'Private');

    await expect(
      videosService.startUpload(draft.id, stranger.id, 1024),
    ).rejects.toThrow(VideoNotFoundException);
  });

  it('should reject an upload for a video that does not exist', async () => {
    const channel = await createChannel();

    await expect(
      videosService.startUpload(randomUUID(), channel.id, 1024),
    ).rejects.toThrow(VideoNotFoundException);
  });

  it('should complete the upload, move the video to processing and enqueue the job', async () => {
    const channel = await createChannel();
    const draft = await videosService.createDraft(channel.id, 'Complete me');
    const payload = Buffer.from('multipart payload');

    const start = await videosService.startUpload(draft.id, channel.id, 1024);
    const putResponse = await fetch(start.parts[0].url, {
      method: 'PUT',
      body: payload,
    });
    expect(putResponse.status).toBe(200);
    const eTag = putResponse.headers.get('etag');
    expect(eTag).toBeTruthy();
    createdObjects.push(draft.source_key);

    const completed = await videosService.completeUpload(
      draft.id,
      channel.id,
      start.uploadId,
      [{ partNumber: 1, eTag: eTag! }],
    );

    expect(completed.status).toBe(VideoStatus.PROCESSING);

    const persisted = await videoRepository.findOneByOrFail({ id: draft.id });
    expect(persisted.status).toBe(VideoStatus.PROCESSING);

    const head = await client.send(
      new HeadObjectCommand({ Bucket: videosBucket, Key: draft.source_key }),
    );
    expect(head.ContentLength).toBe(payload.length);

    // Query every state: a worker consuming the queue (e.g. the `worker`
    // service in Compose) may have already moved the job on.
    const jobs = await queue.getJobs([
      'waiting',
      'delayed',
      'active',
      'completed',
      'failed',
    ]);
    const job = jobs.find((candidate) => candidate.data.videoId === draft.id);
    expect(job).toBeDefined();
    expect(job?.data.sourceKey).toBe(draft.source_key);
  });

  it.each([
    ['an empty parts array', []],
    ['a part with partNumber 0', [{ partNumber: 0, eTag: '"abc"' }]],
    ['a part with an empty eTag', [{ partNumber: 1, eTag: '' }]],
  ])('should reject completion with %s', async (_label, parts) => {
    const channel = await createChannel();
    const draft = await videosService.createDraft(channel.id, 'Bad parts');

    await expect(
      videosService.completeUpload(
        draft.id,
        channel.id,
        'any-upload-id',
        parts as { partNumber: number; eTag: string }[],
      ),
    ).rejects.toThrow(InvalidUploadPartsException);
  });

  it('should reject completion when no upload is in progress', async () => {
    const channel = await createChannel();
    const draft = await videosService.createDraft(channel.id, 'No upload');
    const start = await videosService.startUpload(draft.id, channel.id, 1024);

    await client.send(
      new AbortMultipartUploadCommand({
        Bucket: videosBucket,
        Key: draft.source_key,
        UploadId: start.uploadId,
      }),
    );

    await expect(
      videosService.completeUpload(draft.id, channel.id, start.uploadId, [
        { partNumber: 1, eTag: '"abc"' },
      ]),
    ).rejects.toThrow(UploadNotInitiatedException);
  });

  it("should reject completion for another channel's video", async () => {
    const owner = await createChannel();
    const stranger = await createChannel();
    const draft = await videosService.createDraft(owner.id, 'Private');

    await expect(
      videosService.completeUpload(draft.id, stranger.id, 'any-upload-id', [
        { partNumber: 1, eTag: '"abc"' },
      ]),
    ).rejects.toThrow(VideoNotFoundException);
  });

  it('should return the metadata of a video owned by the channel', async () => {
    const channel = await createChannel();
    const draft = await videosService.createDraft(channel.id, 'My video');

    const response = await videosService.getById(draft.id, channel.id);

    expect(response.id).toBe(draft.id);
    expect(response.title).toBe('My video');
    expect(response.status).toBe(VideoStatus.DRAFT);
    expect(response.thumbnailUrl).toBeNull();
    expect(typeof response.createdAt).toBe('string');
    expect(typeof response.updatedAt).toBe('string');
  });

  it('should return a presigned thumbnail URL for a ready video', async () => {
    const channel = await createChannel();
    const draft = await videosService.createDraft(channel.id, 'Ready video');
    const thumbnailKey = `thumbnails/${draft.id}.jpg`;
    const thumbnailBody = Buffer.from('fake-jpeg-bytes');
    const metadata = { codec: 'h264', width: 1920, height: 1080 };

    await client.send(
      new PutObjectCommand({
        Bucket: thumbnailsBucket,
        Key: thumbnailKey,
        Body: thumbnailBody,
      }),
    );
    createdThumbnails.push(thumbnailKey);

    const video = await videoRepository.findOneByOrFail({ id: draft.id });
    video.status = VideoStatus.READY;
    video.thumbnail_key = thumbnailKey;
    video.duration_seconds = 42.5;
    video.metadata = metadata;
    await videoRepository.save(video);

    const response = await videosService.getById(draft.id, channel.id);

    expect(response.status).toBe(VideoStatus.READY);
    expect(response.durationSeconds).toBe(42.5);
    expect(response.metadata).toEqual(metadata);
    expect(response.thumbnailUrl).toBeTruthy();

    const fetched = await fetch(response.thumbnailUrl!);
    expect(fetched.status).toBe(200);
    expect(Buffer.from(await fetched.arrayBuffer())).toEqual(thumbnailBody);
  });

  it("should reject metadata for another channel's video", async () => {
    const owner = await createChannel();
    const stranger = await createChannel();
    const draft = await videosService.createDraft(owner.id, 'Private');

    await expect(videosService.getById(draft.id, stranger.id)).rejects.toThrow(
      VideoNotFoundException,
    );
  });

  it('should reject metadata for a video that does not exist', async () => {
    const channel = await createChannel();

    await expect(
      videosService.getById(randomUUID(), channel.id),
    ).rejects.toThrow(VideoNotFoundException);
  });

  async function createReadyVideo(): Promise<{
    channel: Channel;
    video: Video;
    body: Buffer;
  }> {
    const channel = await createChannel();
    const draft = await videosService.createDraft(channel.id, 'Ready video');
    const body = Buffer.from('streamtube source object');

    await client.send(
      new PutObjectCommand({
        Bucket: videosBucket,
        Key: draft.source_key,
        Body: body,
      }),
    );
    createdObjects.push(draft.source_key);

    await videoRepository.update(draft.id, { status: VideoStatus.READY });
    const video = await videoRepository.findOneByOrFail({ id: draft.id });

    return { channel, video, body };
  }

  it('should return a stream URL that serves the source object', async () => {
    const { channel, video, body } = await createReadyVideo();

    const { url } = await videosService.getStreamUrl(video.id, channel.id);

    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(body.toString());
  });

  it('should return a stream URL that answers Range requests with 206', async () => {
    const { channel, video, body } = await createReadyVideo();

    const { url } = await videosService.getStreamUrl(video.id, channel.id);

    const response = await fetch(url, { headers: { Range: 'bytes=0-9' } });
    expect(response.status).toBe(206);
    expect(await response.text()).toBe(body.subarray(0, 10).toString());
  });

  it('should return a download URL with an attachment disposition', async () => {
    const { channel, video } = await createReadyVideo();

    const { url } = await videosService.getDownloadUrl(video.id, channel.id);

    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('attachment');
  });

  it.each([VideoStatus.DRAFT, VideoStatus.PROCESSING, VideoStatus.ERROR])(
    'should reject streaming a video with status "%s"',
    async (status) => {
      const channel = await createChannel();
      const draft = await videosService.createDraft(channel.id, 'Not ready');
      await videoRepository.update(draft.id, { status });

      await expect(
        videosService.getStreamUrl(draft.id, channel.id),
      ).rejects.toThrow(VideoNotReadyException);
      await expect(
        videosService.getDownloadUrl(draft.id, channel.id),
      ).rejects.toThrow(VideoNotReadyException);
    },
  );

  it("should reject streaming another channel's video", async () => {
    const { video } = await createReadyVideo();
    const stranger = await createChannel();

    await expect(
      videosService.getStreamUrl(video.id, stranger.id),
    ).rejects.toThrow(VideoNotFoundException);
  });

  it('should reject streaming a video that does not exist', async () => {
    const channel = await createChannel();

    await expect(
      videosService.getStreamUrl(randomUUID(), channel.id),
    ).rejects.toThrow(VideoNotFoundException);
  });
});
