import { IsOptional, IsString, MaxLength } from 'class-validator';

export class UploadSignatureDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  label?: string;
}
