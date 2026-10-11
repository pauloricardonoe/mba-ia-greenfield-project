import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import {
  VideoNotDraftException,
  VideoNotFoundException,
  VideoTooLargeException,
} from './exceptions/video.exception';
import {
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_PARTS,
  UPLOAD_PART_SIZE,
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

  private buildSourceKey(videoId: string): string {
    return `videos/${videoId}/${randomUUID()}.mp4`;
  }
}
