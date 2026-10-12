import { createWriteStream } from 'node:fs';
import { basename } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';

export interface UploadPart {
  partNumber: number;
  eTag: string;
}

export interface PresignGetOptions {
  expiresIn?: number;
  download?: boolean;
}

@Injectable()
export class StorageService {
  private readonly client: S3Client;
  private readonly videosBucket: string;
  private readonly thumbnailsBucket: string;
  private readonly presignExpirySeconds: number;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.client = new S3Client({
      region: config.region,
      endpoint: `http://${config.host}:${config.port}`,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
    });
    this.videosBucket = config.videosBucket;
    this.thumbnailsBucket = config.thumbnailsBucket;
    this.presignExpirySeconds = config.presignExpirySeconds;
  }

  async ensureBuckets(): Promise<void> {
    await this.ensureBucket(this.videosBucket);
    await this.ensureBucket(this.thumbnailsBucket);
  }

  async createMultipartUpload(key: string): Promise<string> {
    const { UploadId } = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.videosBucket,
        Key: key,
      }),
    );

    if (!UploadId) {
      throw new Error(`Multipart upload for "${key}" returned no UploadId`);
    }

    return UploadId;
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: this.videosBucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: this.presignExpirySeconds },
    );
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: UploadPart[],
  ): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.videosBucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.eTag,
          })),
        },
      }),
    );
  }

  async presignGetObject(
    key: string,
    options: PresignGetOptions = {},
  ): Promise<string> {
    return this.presignGet(this.videosBucket, key, options);
  }

  async downloadObjectToFile(key: string, destination: string): Promise<void> {
    const { Body } = await this.client.send(
      new GetObjectCommand({ Bucket: this.videosBucket, Key: key }),
    );

    if (!Body) {
      throw new Error(`Object "${key}" has no body`);
    }

    await pipeline(Body as Readable, createWriteStream(destination));
  }

  async uploadThumbnail(
    key: string,
    body: Buffer,
    contentType = 'image/jpeg',
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.thumbnailsBucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async presignGetThumbnail(
    key: string,
    options: PresignGetOptions = {},
  ): Promise<string> {
    return this.presignGet(this.thumbnailsBucket, key, options);
  }

  private async presignGet(
    bucket: string,
    key: string,
    options: PresignGetOptions,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ...(options.download
          ? {
              ResponseContentDisposition: `attachment; filename="${basename(key)}"`,
            }
          : {}),
      }),
      { expiresIn: options.expiresIn ?? this.presignExpirySeconds },
    );
  }

  private async ensureBucket(bucket: string): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
      await this.client.send(new CreateBucketCommand({ Bucket: bucket }));
    }
  }
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const { name, $metadata } = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };

  return name === 'NotFound' || $metadata?.httpStatusCode === 404;
}
