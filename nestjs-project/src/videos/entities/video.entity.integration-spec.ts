import { randomUUID } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { VideoStatus } from '../videos.constants';
import { Video } from './video.entity';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_user_${n}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${n}`,
        nickname: `videochan${n}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(channel: Channel, overrides: Partial<Video> = {}): Video {
    return videoRepository.create({
      channel_id: channel.id,
      title: 'My first video',
      source_key: `videos/${randomUUID()}.mp4`,
      ...overrides,
    });
  }

  it('should auto-generate id, created_at and updated_at', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(buildVideo(channel));

    expect(saved.id).toBeDefined();
    expect(saved.created_at).toBeInstanceOf(Date);
    expect(saved.updated_at).toBeInstanceOf(Date);
  });

  it('should default status to draft when omitted', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(buildVideo(channel));

    expect(saved.status).toBe(VideoStatus.DRAFT);
  });

  it('should reject a status outside the enum', async () => {
    const channel = await createChannel();

    await expect(
      videoRepository.save(
        buildVideo(channel, { status: 'published' as VideoStatus }),
      ),
    ).rejects.toThrow();
  });

  it('should reject a video without title', async () => {
    const channel = await createChannel();

    await expect(
      videoRepository.save(
        buildVideo(channel, { title: undefined as unknown as string }),
      ),
    ).rejects.toThrow();
  });

  it('should reject a video without source_key', async () => {
    const channel = await createChannel();

    await expect(
      videoRepository.save(
        buildVideo(channel, { source_key: undefined as unknown as string }),
      ),
    ).rejects.toThrow();
  });

  it('should reject a video referencing a non-existent channel', async () => {
    await expect(
      videoRepository.save(
        videoRepository.create({
          channel_id: randomUUID(),
          title: 'Orphan video',
          source_key: `videos/${randomUUID()}.mp4`,
        }),
      ),
    ).rejects.toThrow();
  });

  it('should load the owning channel via the ManyToOne relation', async () => {
    const channel = await createChannel();
    await videoRepository.save(buildVideo(channel));

    const found = await videoRepository.findOne({
      where: { channel_id: channel.id },
      relations: ['channel'],
    });

    expect(found?.channel.id).toBe(channel.id);
  });

  it('should round-trip jsonb metadata and numeric duration_seconds', async () => {
    const channel = await createChannel();
    const metadata = {
      codec: 'h264',
      width: 1920,
      height: 1080,
      bitrate: 4500,
    };

    const saved = await videoRepository.save(
      buildVideo(channel, { metadata, duration_seconds: 12.5 }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.metadata).toEqual(metadata);
    expect(found.duration_seconds).toBe(12.5);
  });
});
