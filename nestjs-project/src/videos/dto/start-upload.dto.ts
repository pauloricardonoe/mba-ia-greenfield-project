import { IsInt, Min } from 'class-validator';

export class StartUploadDto {
  /** Total size of the object to upload, in bytes. */
  @IsInt()
  @Min(1)
  sizeBytes: number;
}
