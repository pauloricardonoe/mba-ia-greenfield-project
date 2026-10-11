import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import ffmpeg from 'fluent-ffmpeg';
import { Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import {
  VIDEO_QUEUE,
  VideoStatus,
  type VideoJobData,
} from './videos.constants';

interface ProbeResult {
  durationSeconds: number | null;
  metadata: Record<string, unknown>;
}

const THUMBNAIL_FILENAME = 'thumbnail.jpg';
const THUMBNAIL_TIMESTAMP = '1';

@Processor(VIDEO_QUEUE, { concurrency: 2 })
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
  ) {
    super();
  }

  async process(job: Job<VideoJobData>): Promise<void> {
    const { videoId, sourceKey } = job.data;
    const workDir = await mkdtemp(join(tmpdir(), 'streamtube-'));
    const sourcePath = join(workDir, 'source');
    const thumbnailPath = join(workDir, THUMBNAIL_FILENAME);

    try {
      await this.storageService.downloadObjectToFile(sourceKey, sourcePath);

      const probe = await probeVideo(sourcePath);
      await renderThumbnail(sourcePath, workDir);

      const thumbnailKey = `thumbnails/${videoId}.jpg`;
      await this.storageService.uploadThumbnail(
        thumbnailKey,
        await readFile(thumbnailPath),
      );

      const video = await this.videoRepository.findOneBy({ id: videoId });

      if (!video) {
        throw new Error(`Video "${videoId}" no longer exists`);
      }

      video.status = VideoStatus.READY;
      video.duration_seconds = probe.durationSeconds;
      video.metadata = probe.metadata;
      video.thumbnail_key = thumbnailKey;
      video.error_message = null;
      await this.videoRepository.save(video);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<VideoJobData>, error: Error): Promise<void> {
    const attempts = job.opts.attempts ?? 1;

    if (job.attemptsMade < attempts) {
      this.logger.warn(
        `Video ${job.data.videoId} failed on attempt ${job.attemptsMade}/${attempts}: ${error.message}`,
      );
      return;
    }

    this.logger.error(
      `Video ${job.data.videoId} processing failed permanently: ${error.message}`,
    );

    await this.videoRepository.update(job.data.videoId, {
      status: VideoStatus.ERROR,
      error_message: error.message,
    });
  }
}

function probeVideo(filePath: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (error, data) => {
      if (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      const format = data.format;

      resolve({
        durationSeconds: format?.duration ? Number(format.duration) : null,
        metadata: {
          formatName: format?.format_name ?? null,
          durationSeconds: format?.duration ? Number(format.duration) : null,
          sizeBytes: format?.size ? Number(format.size) : null,
          bitRate: format?.bit_rate ? Number(format.bit_rate) : null,
          streams: (data.streams ?? []).map((stream) => ({
            type: stream.codec_type ?? null,
            codec: stream.codec_name ?? null,
            width: stream.width ?? null,
            height: stream.height ?? null,
          })),
        },
      });
    });
  });
}

function renderThumbnail(input: string, folder: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .screenshots({
        timestamps: [THUMBNAIL_TIMESTAMP],
        filename: THUMBNAIL_FILENAME,
        folder,
      })
      .on('end', () => resolve())
      .on('error', (error) =>
        reject(error instanceof Error ? error : new Error(String(error))),
      );
  });
}
