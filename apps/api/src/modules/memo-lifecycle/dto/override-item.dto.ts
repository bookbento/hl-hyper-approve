/**
 * OverrideItem DTO — Nest port of backend/src/types/memoOverride.ts
 *
 * Used in CreateMemoDto and UpdateMemoDto to validate individual approver
 * override entries that arrive as a JSON string in multipart form-data.
 *
 * Security note (คุณอิเอริ):
 *   - userId is allowed to be null (FLEXIBLE_SLOT).
 *   - slotType is validated as a string union via @IsIn.
 *   - approvalRequirement is validated as "ALL" | "ANY".
 */

import {
  IsIn,
  IsInt,
  IsOptional,
  IsBoolean,
  IsString,
  IsNumber,
  Min,
} from 'class-validator';

export type SlotType =
  | 'FIXED_USER'
  | 'MEMO_REQUESTER'
  | 'DEPARTMENT_HEAD'
  | 'FLEXIBLE_SLOT'
  | null;

export class OverrideItemDto {
  @IsOptional()
  @IsNumber()
  userId?: number | null;

  @IsInt()
  @Min(0)
  level!: number;

  @IsOptional()
  @IsBoolean()
  isSigReq?: boolean;

  @IsOptional()
  @IsString()
  roleDescription?: string | null;

  @IsOptional()
  @IsIn(['FIXED_USER', 'MEMO_REQUESTER', 'DEPARTMENT_HEAD', 'FLEXIBLE_SLOT'])
  slotType?: SlotType;

  @IsOptional()
  @IsInt()
  loaUserPivotId?: number | null;

  @IsOptional()
  @IsIn(['ALL', 'ANY'])
  approvalRequirement?: 'ALL' | 'ANY';
}
