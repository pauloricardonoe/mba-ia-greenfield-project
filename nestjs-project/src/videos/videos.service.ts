import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { StorageService, type UploadPart } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import {
  InvalidUploadPartsException,
  UploadNotInitiatedException,
  VideoNotDraftException,
  VideoNotFoundException,
  VideoTooLargeException,
} from './exceptions/video.exception';
import {
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_PARTS,
  UPLOAD_PART_SIZE,
  VIDEO_JOB_NAME,
  VIDEO_JOB_OPTIONS,
  VIDEO_QUEUE,
  VideoStatus,
} from './videos.constants';

export interface PresignedUploadPart {
  partNumber: number;
  url: string;
}

export interface StartUploadResult {
  uploadId: string;
  key: string;
  partSize: number;
  parts: PresignedUploadPart[];
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    @InjectQueue(VIDEO_QUEUE)
    private readonly videoQueue: Queue,
  ) {}

  async createDraft(channelId: string, title: string): Promise<Video> {
    const id = randomUUID();

    return this.videoRepository.save(
      this.videoRepository.create({
        id,
        channel_id: channelId,
        title,
        status: VideoStatus.DRAFT,
        source_key: this.buildSourceKey(id),
      }),
    );
  }

  async startUpload(
    videoId: string,
    channelId: string,
    sizeBytes: number,
  ): Promise<StartUploadResult> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId, channel_id: channelId },
    });

    if (!video) {
      throw new VideoNotFoundException();
    }

    if (video.status !== VideoStatus.DRAFT) {
      throw new VideoNotDraftException();
    }

    if (sizeBytes > MAX_UPLOAD_BYTES) {
      throw new VideoTooLargeException();
    }

    const partSize = this.computePartSize(sizeBytes);
    const partCount = Math.max(1, Math.ceil(sizeBytes / partSize));

    const uploadId = await this.storageService.createMultipartUpload(
      video.source_key,
    );

    const parts = await Promise.all(
      Array.from({ length: partCount }, async (_unused, index) => {
        const partNumber = index + 1;
        return {
          partNumber,
          url: await this.storageService.presignUploadPart(
            video.source_key,
            uploadId,
            partNumber,
          ),
        };
      }),
    );

    return { uploadId, key: video.source_key, partSize, parts };
  }

  private computePartSize(sizeBytes: number): number {
    return Math.max(
      UPLOAD_PART_SIZE,
      Math.ceil(sizeBytes / MAX_UPLOAD_PARTS),
    );
  }

  async completeUpload(
    videoId: string,
    channelId: string,
    uploadId: string,
    parts: UploadPart[],
  ): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId, channel_id: channelId },
    });

    if (!video) {
      throw new VideoNotFoundException();
    }

    if (!this.areValidParts(parts)) {
      throw new InvalidUploadPartsException();
    }

    try {
      await this.storageService.completeMultipartUpload(
        video.source_key,
        uploadId,
        parts,
      );
    } catch (error) {
      if (isNoSuchUpload(error)) {
        throw new UploadNotInitiatedException();
      }
      throw error;
    }

    video.status = VideoStatus.PROCESSING;
    const saved = await this.videoRepository.save(video);

    await this.videoQueue.add(
      VIDEO_JOB_NAME,
      { videoId: saved.id, sourceKey: saved.source_key },
      VIDEO_JOB_OPTIONS,
    );

    return saved;
  }

  private areValidParts(parts: UploadPart[]): boolean {
    return (
      Array.isArray(parts) &&
      parts.length > 0 &&
      parts.every(
        (part) =>
          part !== null &&
          typeof part === 'object' &&
          Number.isInteger(part.partNumber) &&
          part.partNumber >= 1 &&
          typeof part.eTag === 'string' &&
          part.eTag.length > 0,
      )
    );
  }

  private buildSourceKey(videoId: string): string {
    return `videos/${videoId}/${randomUUID()}.mp4`;
  }
}

/**
 * S3/MinIO answer `NoSuchUpload` when the upload id is unknown — the only
 * signal available that no multipart upload was started for the object.
 */
function isNoSuchUpload(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const { name, Code, $metadata } = error as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };

  return (
    name === 'NoSuchUpload' ||
    Code === 'NoSuchUpload' ||
    $metadata?.httpStatusCode === 404
  );
}
