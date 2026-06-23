import { IsString, IsNotEmpty, IsOptional, IsInt, IsObject } from 'class-validator';

export class CreateLogDto {
  @IsString()
  @IsNotEmpty()
  actionType!: string;

  @IsString()
  @IsNotEmpty()
  module!: string;

  @IsOptional()
  @IsInt()
  targetId?: number | null;

  @IsOptional()
  @IsString()
  targetName?: string | null;

  @IsOptional()
  @IsObject()
  details?: Record<string, unknown> | null;
}
