import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import {
  createS3TestClient,
  TEST_THUMBNAILS_BUCKET,
  TEST_VIDEOS_BUCKET,
} from '../test/s3-test-client';
import { cleanAllTables } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { WorkerModule } from '../worker.module';
import { Video } from './entities/video.entity';
import { VIDEO_JOB_NAME, VIDEO_QUEUE, VideoStatus } from './videos.constants';

const execFileAsync = promisify(execFile);

async function generateTestVideo(): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'streamtube-fixture-'));
  const filePath = join(dir, 'sample.mp4');

  try {
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=2:size=320x240:rate=10',
      '-pix_fmt',
      'yuv420p',
      filePath,
    ]);
    return await readFile(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('VideoProcessor (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let queue: Queue;
  let client: S3Client;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  const createdObjects: { bucket: string; key: string }[] = [];

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    // onModuleInit is what instantiates the BullMQ worker (BullExplorer).
    await module.init();

    dataSource = module.get(DataSource);
    queue = module.get<Queue>(getQueueToken(VIDEO_QUEUE));
    client = createS3TestClient();

    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  }, 60000);

  afterAll(async () => {
    await module.close();
    await Promise.all(
      createdObjects.map(({ bucket, key }) =>
        client
          .send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
          .catch(() => undefined),
      ),
    );
    client.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.drain();
  });

  let counter = 0;
  async function createProcessingVideo(sourceKey: string): Promise<Video> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `processor_${n}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `Channel ${n}`,
        nickname: `processor${n}`,
        user_id: user.id,
      }),
    );

    return videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: `Video ${n}`,
        status: VideoStatus.PROCESSING,
        source_key: sourceKey,
      }),
    );
  }

  async function uploadSource(key: string, body: Buffer): Promise<void> {
    await client.send(
      new PutObjectCommand({
        Bucket: TEST_VIDEOS_BUCKET,
        Key: key,
        Body: body,
      }),
    );
    createdObjects.push({ bucket: TEST_VIDEOS_BUCKET, key });
  }

  async function enqueue(video: Video, attempts = 1): Promise<void> {
    await queue.add(
      VIDEO_JOB_NAME,
      { videoId: video.id, sourceKey: video.source_key },
      { attempts },
    );
  }

  async function waitForStatus(
    videoId: string,
    status: VideoStatus,
    timeoutMs = 30000,
  ): Promise<Video> {
    const deadline = Date.now() + timeoutMs;
    let last: Video | null = null;

    while (Date.now() < deadline) {
      last = await videoRepository.findOneBy({ id: videoId });
      if (last?.status === status) {
        return last;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    throw new Error(
      `Video ${videoId} did not reach "${status}" within ${timeoutMs}ms ` +
        `(last status: ${last?.status}, error_message: ${last?.error_message})`,
    );
  }

  it('should process a video, generate the thumbnail and mark it ready', async () => {
    const sourceKey = `videos/${randomUUID()}/source.mp4`;
    const video = await createProcessingVideo(sourceKey);
    await uploadSource(sourceKey, await generateTestVideo());

    await enqueue(video);

    const processed = await waitForStatus(video.id, VideoStatus.READY);

    expect(processed.duration_seconds).toBeGreaterThan(0);
    expect(processed.metadata).toMatchObject({
      formatName: expect.stringContaining('mp4') as string,
    });
    expect(processed.thumbnail_key).toBe(`thumbnails/${video.id}.jpg`);
    expect(processed.error_message).toBeNull();

    const thumbnail = await client.send(
      new GetObjectCommand({
        Bucket: TEST_THUMBNAILS_BUCKET,
        Key: processed.thumbnail_key!,
      }),
    );
    createdObjects.push({
      bucket: TEST_THUMBNAILS_BUCKET,
      key: processed.thumbnail_key!,
    });

    const bytes = Buffer.from(await thumbnail.Body!.transformToByteArray());
    expect(bytes.length).toBeGreaterThan(0);
    // JPEG magic number — the thumbnail must be a readable JPEG.
    expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  }, 60000);

  it('should mark the video as error when the file cannot be processed', async () => {
    const sourceKey = `videos/${randomUUID()}/broken.bin`;
    const video = await createProcessingVideo(sourceKey);
    await uploadSource(sourceKey, Buffer.from('this is not a video'));

    await enqueue(video);

    const failed = await waitForStatus(video.id, VideoStatus.ERROR);

    expect(failed.error_message).toBeTruthy();
  }, 60000);
});
