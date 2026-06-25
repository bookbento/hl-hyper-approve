/**
 * CreateMemoDto — NestJS DTO for POST /api/memos
 *
 * Note: the request arrives as multipart/form-data.
 * All fields come in as strings from the form; Transform decorators coerce them.
 * Files are injected by FileFieldsInterceptor and are NOT validated here.
 *
 * Security (คุณอิเอริ):
 *   - All integer fields are validated/transformed with @Transform + @IsInt.
 *   - approversOverride and other JSON-string fields are validated as strings;
 *     parsing happens in the service layer.
 *   - No raw HTML fields are accepted.
 */

import {
  IsString,
  IsOptional,
  IsInt,
  Min,
  MaxLength,
  IsIn,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

function toIntOrUndefined(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export class CreateMemoDto {
  @IsString()
  @MaxLength(500)
  subject!: string;

  @Transform(({ value }) => toIntOrUndefined(value))
  @IsInt()
  @Min(1)
  businessUnitId!: number;

  @Transform(({ value }) => toIntOrUndefined(value))
  @IsOptional()
  @IsInt()
  @Min(1)
  departmentId?: number;

  @Transform(({ value }) => toIntOrUndefined(value))
  @IsInt()
  @Min(1)
  userId!: number;

  @Transform(({ value }) => toIntOrUndefined(value))
  @IsOptional()
  @IsInt()
  @Min(1)
  memotypeId?: number;

  @Transform(({ value }) => toIntOrUndefined(value))
  @IsOptional()
  @IsInt()
  @Min(1)
  approvalLineId?: number;

  /** Status: 1 = Draft, 2 = Processing */
  @IsOptional()
  @IsIn(['1', '2', 1, 2])
  statusId?: string | number;

  /** ISO date string or YYYY-MM-DD */
  @IsOptional()
  @IsString()
  expiresAt?: string;

  /** JSON string: OverrideItem[] */
  @IsOptional()
  @IsString()
  approversOverride?: string;

  /** JSON string: number[] of file IDs */
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

  /** CC user IDs: either a JSON array string or repeated form values */
  @IsOptional()
  ccUsers?: unknown;

  @IsOptional()
  ccUserIds?: unknown;

  @IsOptional()
  cc?: unknown;

  /** CC group IDs */
  @IsOptional()
  ccGroupIds?: unknown;

  @IsOptional()
  ccGroups?: unknown;

  @IsOptional()
  groups?: unknown;
}
