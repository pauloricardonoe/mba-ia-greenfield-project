import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video } from '../src/videos/entities/video.entity';
import {
  MAX_UPLOAD_BYTES,
  VideoStatus,
} from '../src/videos/videos.constants';
import { VideosModule } from '../src/videos/videos.module';

const PASSWORD = 'password123';

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let throttlerStorage: ThrottlerStorageService;
  let accessToken: string;
  let otherAccessToken: string;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule, VideosModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);

    await cleanAllTables(dataSource);

    throttlerStorage.storage.clear();
    accessToken = await registerConfirmedUser('videos_e2e@example.com');
    throttlerStorage.storage.clear();
    otherAccessToken = await registerConfirmedUser(
      'videos_e2e_other@example.com',
    );
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    throttlerStorage.storage.clear();
  });

  async function registerConfirmedUser(email: string): Promise<string> {
    const authService = app.get(AuthService);
    const mailServiceInstance = (authService as any).mailService;
    let confirmationToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, token: string) => {
        confirmationToken = token;
      });

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: PASSWORD })
      .expect(201);

    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: confirmationToken })
      .expect(204);

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);

    return login.body.access_token;
  }

  async function createDraft(token = accessToken): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'My video' })
      .expect(201);

    return response.body.id;
  }

  function post(path: string, token = accessToken) {
    return request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${token}`);
  }

  function get(path: string, token = accessToken) {
    return request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${token}`);
  }

  describe('POST /videos', () => {
    it('should reject a request without an access token', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send({ title: 'No auth' })
        .expect(401);
    });

    it('should reject a missing title', async () => {
      await post('/videos').send({}).expect(400);
    });

    it('should reject an empty title', async () => {
      await post('/videos').send({ title: '' }).expect(400);
    });

    it('should reject a title longer than 200 characters', async () => {
      await post('/videos').send({ title: 'a'.repeat(201) }).expect(400);
    });

    it('should create a draft owned by the authenticated user', async () => {
      const response = await post('/videos')
        .send({ title: 'My video' })
        .expect(201);

      expect(response.body.id).toBeDefined();
      expect(response.body.title).toBe('My video');
      expect(response.body.status).toBe('draft');
      expect(typeof response.body.createdAt).toBe('string');
    });
  });

  describe('POST /videos/:id/upload-urls', () => {
    it('should reject a missing sizeBytes', async () => {
      const id = await createDraft();

      await post(`/videos/${id}/upload-urls`).send({}).expect(400);
    });

    it('should reject a non-integer sizeBytes', async () => {
      const id = await createDraft();

      await post(`/videos/${id}/upload-urls`)
        .send({ sizeBytes: 'not-a-number' })
        .expect(400);
    });

    it('should reject a sizeBytes below 1', async () => {
      const id = await createDraft();

      await post(`/videos/${id}/upload-urls`).send({ sizeBytes: 0 }).expect(400);
    });

    it('should return one presigned URL per part', async () => {
      const id = await createDraft();

      const response = await post(`/videos/${id}/upload-urls`)
        .send({ sizeBytes: 1024 })
        .expect(200);

      expect(response.body.uploadId).toBeTruthy();
      expect(response.body.key).toBeTruthy();
      expect(response.body.partSize).toBeGreaterThan(0);
      expect(response.body.parts).toHaveLength(1);
      expect(response.body.parts[0].partNumber).toBe(1);
      expect(response.body.parts[0].url).toContain('X-Amz-Signature');
    });

    it('should return 413 when sizeBytes exceeds 10 GiB', async () => {
      const id = await createDraft();

      const response = await post(`/videos/${id}/upload-urls`)
        .send({ sizeBytes: MAX_UPLOAD_BYTES + 1 })
        .expect(413);

      expect(response.body.error).toBe('VIDEO_TOO_LARGE');
    });

    it('should return 409 when the video is not a draft', async () => {
      const id = await createDraft();
      await videoRepository.update(id, { status: VideoStatus.PROCESSING });

      const response = await post(`/videos/${id}/upload-urls`)
        .send({ sizeBytes: 1024 })
        .expect(409);

      expect(response.body.error).toBe('VIDEO_NOT_DRAFT');
    });

    it("should return 404 for a video owned by another channel", async () => {
      const otherId = await createDraft(otherAccessToken);

      const response = await post(`/videos/${otherId}/upload-urls`)
        .send({ sizeBytes: 1024 })
        .expect(404);

      expect(response.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('should return 404 for a video that does not exist', async () => {
      const response = await post(`/videos/${randomUUID()}/upload-urls`)
        .send({ sizeBytes: 1024 })
        .expect(404);

      expect(response.body.error).toBe('VIDEO_NOT_FOUND');
    });
  });

  describe('POST /videos/:id/upload-complete', () => {
    async function startUpload(id: string) {
      const response = await post(`/videos/${id}/upload-urls`)
        .send({ sizeBytes: 1024 })
        .expect(200);

      return response.body as {
        uploadId: string;
        parts: { partNumber: number; url: string }[];
      };
    }

    it('should reject a request without an access token', async () => {
      const id = await createDraft();

      await request(app.getHttpServer())
        .post(`/videos/${id}/upload-complete`)
        .send({ uploadId: 'x', parts: [{ partNumber: 1, eTag: '"abc"' }] })
        .expect(401);
    });

    it('should reject a missing uploadId', async () => {
      const id = await createDraft();

      await post(`/videos/${id}/upload-complete`)
        .send({ parts: [{ partNumber: 1, eTag: '"abc"' }] })
        .expect(400);
    });

    it('should reject an empty parts array', async () => {
      const id = await createDraft();

      await post(`/videos/${id}/upload-complete`)
        .send({ uploadId: 'x', parts: [] })
        .expect(400);
    });

    it('should reject a malformed part', async () => {
      const id = await createDraft();

      await post(`/videos/${id}/upload-complete`)
        .send({ uploadId: 'x', parts: [{ partNumber: 0, eTag: '' }] })
        .expect(400);
    });

    it('should complete the upload and return processing', async () => {
      const id = await createDraft();
      const start = await startUpload(id);

      const putResponse = await fetch(start.parts[0].url, {
        method: 'PUT',
        body: Buffer.from('payload'),
      });
      expect(putResponse.status).toBe(200);
      const eTag = putResponse.headers.get('etag');
      expect(eTag).toBeTruthy();

      const response = await post(`/videos/${id}/upload-complete`)
        .send({ uploadId: start.uploadId, parts: [{ partNumber: 1, eTag: eTag! }] })
        .expect(200);

      expect(response.body.id).toBe(id);
      expect(response.body.status).toBe('processing');
    });

    it('should return 409 when no upload was started', async () => {
      const id = await createDraft();

      const response = await post(`/videos/${id}/upload-complete`)
        .send({
          uploadId: randomUUID(),
          parts: [{ partNumber: 1, eTag: '"abc"' }],
        })
        .expect(409);

      expect(response.body.error).toBe('UPLOAD_NOT_INITIATED');
    });

    it("should return 404 for a video owned by another channel", async () => {
      const otherId = await createDraft(otherAccessToken);

      const response = await post(`/videos/${otherId}/upload-complete`)
        .send({
          uploadId: randomUUID(),
          parts: [{ partNumber: 1, eTag: '"abc"' }],
        })
        .expect(404);

      expect(response.body.error).toBe('VIDEO_NOT_FOUND');
    });
  });

  describe('GET /videos/:id', () => {
    it('should reject a request without an access token', async () => {
      const id = await createDraft();

      await request(app.getHttpServer()).get(`/videos/${id}`).expect(401);
    });

    it('should return the metadata of a draft', async () => {
      const id = await createDraft();

      const response = await get(`/videos/${id}`).expect(200);

      expect(response.body.id).toBe(id);
      expect(response.body.title).toBe('My video');
      expect(response.body.status).toBe('draft');
      expect(response.body.thumbnailUrl).toBeNull();
      expect(typeof response.body.createdAt).toBe('string');
      expect(typeof response.body.updatedAt).toBe('string');
    });

    it('should return a presigned thumbnailUrl for a ready video', async () => {
      const id = await createDraft();
      await videoRepository.update(id, {
        status: VideoStatus.READY,
        thumbnail_key: `thumbnails/${id}.jpg`,
      });

      const response = await get(`/videos/${id}`).expect(200);

      expect(response.body.status).toBe('ready');
      expect(response.body.thumbnailUrl).toContain('X-Amz-Signature');
    });

    it("should return 404 for a video owned by another channel", async () => {
      const otherId = await createDraft(otherAccessToken);

      const response = await get(`/videos/${otherId}`).expect(404);

      expect(response.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('should return 404 for a video that does not exist', async () => {
      const response = await get(`/videos/${randomUUID()}`).expect(404);

      expect(response.body.error).toBe('VIDEO_NOT_FOUND');
    });
  });

  describe('GET /videos/:id/stream and /download', () => {
    async function createReadyDraft(): Promise<string> {
      const id = await createDraft();
      await videoRepository.update(id, {
        status: VideoStatus.READY,
        thumbnail_key: `thumbnails/${id}.jpg`,
      });
      return id;
    }

    it('should reject a stream request without an access token', async () => {
      const id = await createReadyDraft();

      await request(app.getHttpServer())
        .get(`/videos/${id}/stream`)
        .expect(401);
    });

    it('should return a presigned streaming URL for a ready video', async () => {
      const id = await createReadyDraft();

      const response = await get(`/videos/${id}/stream`).expect(200);

      expect(response.body.url).toContain('X-Amz-Signature');
    });

    it('should return a download URL with an attachment disposition', async () => {
      const id = await createReadyDraft();

      const response = await get(`/videos/${id}/download`).expect(200);

      expect(decodeURIComponent(response.body.url)).toContain('attachment');
    });

    it.each(['stream', 'download'])(
      'should return 409 for a non-ready video (%s)',
      async (route) => {
        const id = await createDraft();

        const response = await get(`/videos/${id}/${route}`).expect(409);

        expect(response.body.error).toBe('VIDEO_NOT_READY');
      },
    );

    it("should return 404 for another channel's video", async () => {
      const otherId = await createDraft(otherAccessToken);

      const response = await get(`/videos/${otherId}/stream`).expect(404);

      expect(response.body.error).toBe('VIDEO_NOT_FOUND');
    });
  });
});
