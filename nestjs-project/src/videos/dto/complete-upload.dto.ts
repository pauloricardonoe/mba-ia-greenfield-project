import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class UploadPartDto {
  /** 1-based index of the part within the multipart upload. */
  @IsInt()
  @Min(1)
  partNumber: number;

  /** ETag returned by storage when the part was uploaded. */
  @IsString()
  @IsNotEmpty()
  eTag: string;
}

export class CompleteUploadDto {
  /** Multipart upload id returned by `upload-urls`. */
  @IsString()
  @IsNotEmpty()
  uploadId: string;

  /** Uploaded parts reported by the client. */
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => UploadPartDto)
  parts: UploadPartDto[];
}
