/**
 * UpdateMemoDto — NestJS DTO for PUT /api/memos/:id
 *
 * Multipart/form-data; same string-coercion pattern as CreateMemoDto.
 * Extra fields for update: removedFileIds, removedAttachedFileIds,
 * fileOrderTokens with "old:" / "new:" prefix tokens.
 */

import {
  IsString,
  IsOptional,
  IsInt,
  Min,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

function toIntOrUndefined(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export class UpdateMemoDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  subject?: string;

  @Transform(({ value }) => toIntOrUndefined(value))
  @IsOptional()
  @IsInt()
  @Min(1)
  businessUnitId?: number;

  @Transform(({ value }) => toIntOrUndefined(value))
  @IsOptional()
  @IsInt()
  @Min(1)
  departmentId?: number;

  @Transform(({ value }) => toIntOrUndefined(value))
  @IsOptional()
  @IsInt()
  @Min(1)
  userId?: number;

  @IsOptional()
  memotypeId?: unknown;

  @IsOptional()
  approvalLineId?: unknown;

  @IsOptional()
  @IsString()
  expiresAt?: string;

  /** JSON string: OverrideItem[] */
  @IsOptional()
  @IsString()
  approversOverride?: string;

  /** JSON string: number[] of removed mainFile IDs */
  @IsOptional()
  @IsString()
  removedFileIds?: string;

  /** JSON string: number[] of removed attachedFile IDs */
  @IsOptional()
  @IsString()
  removedAttachedFileIds?: string;

  /** JSON string: token strings with "old:N" or "new:N" prefix */
  @IsOptional()
  @IsString()
  fileOrderTokens?: string;

  /** JSON string: SigPos[] */
  @IsOptional()
  @IsString()
  sigPositions?: string;

  /** JSON string: DatePos[] */
  @IsOptional()
  @IsString()
  datePositions?: string;

  /** JSON string: MemoNumPos[] */
  @IsOptional()
  @IsString()
  memoNumberPositions?: string;

  /** JSON string: NotePos[] */
  @IsOptional()
  @IsString()
  notePositions?: string;

  /** JSON string: Array<{url: string; title: string}> */
  @IsOptional()
  @IsString()
  urlLinks?: string;
}
