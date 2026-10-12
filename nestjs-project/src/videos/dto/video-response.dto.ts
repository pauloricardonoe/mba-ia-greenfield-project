import { ApiProperty } from '@nestjs/swagger';
import { Video } from '../entities/video.entity';
import { VideoStatus } from '../videos.constants';

export class VideoResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ enum: VideoStatus })
  status: VideoStatus;

  @ApiProperty({ type: Number, nullable: true, required: false })
  durationSeconds: number | null;

  @ApiProperty({ type: Object, nullable: true, required: false })
  metadata: Record<string, unknown> | null;

  @ApiProperty({ nullable: true, required: false })
  thumbnailUrl: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt: string;

  static fromEntity(
    video: Video,
    thumbnailUrl: string | null,
  ): VideoResponseDto {
    return {
      id: video.id,
      title: video.title,
      status: video.status,
      durationSeconds: video.duration_seconds,
      metadata: video.metadata,
      thumbnailUrl,
      createdAt: video.created_at.toISOString(),
      updatedAt: video.updated_at.toISOString(),
    };
  }
}
