import {
  IsOptional,
  IsNumber,
  IsString,
  IsArray,
  IsBoolean,
  Min,
  Max,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

/**
 * DTO for POST /api/memos/search
 * Mirrors SearchMemosRequest from backend/src/services/memoSearch.types.ts
 */
export class SearchMemosDto {
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  page?: number;

  // pageSize can be a number or the literal string "all"
  @IsOptional()
  pageSize?: number | 'all';

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  view?: string;

  @IsOptional()
  businessUnitId?: number | 'All';

  @IsOptional()
  departmentId?: number | 'All';

  @IsOptional()
  @IsArray()
  statuses?: string[];

  @IsOptional()
  @IsArray()
  currentApproverIds?: number[];

  @IsOptional()
  @IsArray()
  currentApproverNames?: string[];

  @IsOptional()
  @IsArray()
  extraApproverIds?: number[];

  @IsOptional()
  @IsArray()
  extraApproverNames?: string[];

  @IsOptional()
  @IsArray()
  ccUserIds?: number[];

  @IsOptional()
  @IsArray()
  ccStatuses?: string[];

  @IsOptional()
  @IsString()
  subjectContains?: string;

  @IsOptional()
  @IsString()
  memonumberContains?: string;

  @IsOptional()
  @IsString()
  authorContains?: string;

  @IsOptional()
  @IsString()
  latestCommentContains?: string;

  @IsOptional()
  @IsString()
  extraApproverContains?: string;

  @IsOptional()
  @IsString()
  expiresFrom?: string;

  @IsOptional()
  @IsString()
  expiresTo?: string;

  @IsOptional()
  @IsString()
  createdFrom?: string;

  @IsOptional()
  @IsString()
  createdTo?: string;

  @IsOptional()
  @IsArray()
  expiryStates?: string[];

  @IsOptional()
  @IsString()
  sortBy?: string;

  @IsOptional()
  @IsString()
  sortDir?: 'asc' | 'desc';

  @IsOptional()
  @IsBoolean()
  includeStatCounts?: boolean;

  @IsOptional()
  @IsBoolean()
  includeFacets?: boolean;
}
