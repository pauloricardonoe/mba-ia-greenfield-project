import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ChannelsService } from '../channels/channels.service';
import { ChannelNotFoundException } from '../common/exceptions/domain.exception';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { StartUploadDto } from './dto/start-upload.dto';
import type { StartUploadResult } from './videos.service';
import { VideosService } from './videos.service';

interface VideoDraftResponse {
  id: string;
  title: string;
  status: string;
  createdAt: string;
}

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(
    private readonly videosService: VideosService,
    private readonly channelsService: ChannelsService,
  ) {}

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Create a video draft',
    description:
      'Pre-registers a video owned by the authenticated user as a draft.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        title: { type: 'string' },
        status: { type: 'string', example: 'draft' },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<VideoDraftResponse> {
    const channel = await this.resolveChannel(user.sub);
    const video = await this.videosService.createDraft(channel.id, dto.title);

    return {
      id: video.id,
      title: video.title,
      status: video.status,
      createdAt: video.created_at.toISOString(),
    };
  }

  @Post(':id/upload-urls')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Start a multipart upload',
    description:
      'Starts an S3 multipart upload for a draft video and returns one presigned PUT URL per part. The client uploads the parts directly to storage.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned part URLs',
    schema: {
      properties: {
        uploadId: { type: 'string' },
        key: { type: 'string' },
        partSize: { type: 'number' },
        parts: {
          type: 'array',
          items: {
            properties: {
              partNumber: { type: 'number' },
              url: { type: 'string' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not owned by the requester',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not a draft',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'File exceeds the 10GB limit',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async startUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StartUploadDto,
  ): Promise<StartUploadResult> {
    const channel = await this.resolveChannel(user.sub);

    return this.videosService.startUpload(id, channel.id, dto.sizeBytes);
  }

  @Get(':id')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get video metadata',
    description:
      'Returns the metadata of a video owned by the authenticated user, including a presigned thumbnail URL when the video is ready.',
  })
  @ApiResponse({
    status: 200,
    description: 'Video metadata',
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not owned by the requester',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async findOne(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<VideoResponseDto> {
    const channel = await this.resolveChannel(user.sub);

    return this.videosService.getById(id, channel.id);
  }

  @Get(':id/stream')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get a streaming URL',
    description:
      'Returns a short-lived presigned GET URL for the source object. The client streams directly from storage and may send HTTP Range headers (storage answers 206 Partial Content).',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned streaming URL',
    schema: {
      properties: {
        url: { type: 'string', format: 'uri' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not owned by the requester',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ url: string }> {
    const channel = await this.resolveChannel(user.sub);

    return this.videosService.getStreamUrl(id, channel.id);
  }

  @Get(':id/download')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get a download URL',
    description:
      'Returns a short-lived presigned GET URL with a Content-Disposition attachment override so the browser downloads the file.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned download URL',
    schema: {
      properties: {
        url: { type: 'string', format: 'uri' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not owned by the requester',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ url: string }> {
    const channel = await this.resolveChannel(user.sub);

    return this.videosService.getDownloadUrl(id, channel.id);
  }

  @Post(':id/upload-complete')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a multipart upload',
    description:
      'Completes the multipart upload in storage, moves the video to `processing` and enqueues the processing job.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed and processing enqueued',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        status: { type: 'string', example: 'processing' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid upload parts or validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not owned by the requester',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'No upload in progress for this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<{ id: string; status: string }> {
    const channel = await this.resolveChannel(user.sub);
    const video = await this.videosService.completeUpload(
      id,
      channel.id,
      dto.uploadId,
      dto.parts,
    );

    return { id: video.id, status: video.status };
  }

  private async resolveChannel(userId: string) {
    const channel = await this.channelsService.findByUserId(userId);

    if (!channel) {
      throw new ChannelNotFoundException();
    }

    return channel;
  }
}
