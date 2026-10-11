import { IsString, Length } from 'class-validator';

export class CreateVideoDto {
  /** Title of the video. */
  @IsString()
  @Length(1, 200, { message: 'title must be between 1 and 200 characters' })
  title: string;
}
