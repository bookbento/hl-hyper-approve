import { IsBoolean, IsNumber, IsOptional, IsArray } from 'class-validator';
import { Transform, Type } from 'class-transformer';

export class ReplaceApproverDto {
  @IsNumber()
  @Type(() => Number)
  fromUserId: number;

  @IsNumber()
  @Type(() => Number)
  toUserId: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  businessUnitId?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  departmentId?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  memoTypeId?: number;

  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value !== false && value !== 'false')
  affectTemplates?: boolean = true;

  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value !== false && value !== 'false')
  affectRunningMemos?: boolean = true;

  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true')
  affectCcGroups?: boolean = false;

  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true')
  dryRun?: boolean = false;

  @IsOptional()
  @IsArray()
  lineOfApprovalIds?: number[];
}
