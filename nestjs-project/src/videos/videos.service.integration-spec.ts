import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  AbortMultipartUploadCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import {
  VideoNotDraftException,
  VideoNotFoundException,
  VideoTooLargeException,
} from './exceptions/video.exception';
import {
  MAX_UPLOAD_BYTES,
  UPLOAD_PART_SIZE,
  VideoStatus,
} from './videos.constants';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];
const videosBucket = process.env.S3_VIDEOS_BUCKET ?? 'streamtube-videos';

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

describe('VideosService (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let videosService: VideosService;
  let storageService: StorageService;
  let client: S3Client;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  const openUploads: { key: string; uploadId: string }[] = [];

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
      ],
      providers: [VideosService],
    }).compile();

    dataSource = module.get(DataSource);
    videosService = module.get(VideosService);
    storageService = module.get(StorageService);
    client = createVerificationClient();

    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);

    await storageService.ensureBuckets();
  });

  afterAll(async () => {
    await Promise.all(
      openUploads.map(({ key, uploadId }) =>
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
    );
    client.destroy();
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
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

    const sizeBytes = 1024;
    const result = await videosService.startUpload(
      draft.id,
      channel.id,
      sizeBytes,
    );
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
});
