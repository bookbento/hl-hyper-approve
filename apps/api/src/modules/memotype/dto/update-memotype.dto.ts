import { IsString, IsNotEmpty, IsOptional, IsBoolean } from 'class-validator';
import { Transform } from 'class-transformer';

function parseBoolTransform(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return false;
}

export class UpdateMemotypeDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsNotEmpty()
  description!: string;

  @IsString()
  @IsOptional()
  abbreviation?: string;

  @IsOptional()
  businessUnitId?: string | number | null;

  @IsOptional()
  departmentId?: string | number | null;

  @IsOptional()
  @Transform(({ value }) => parseBoolTransform(value))
  @IsBoolean()
  forEveryone?: boolean;

  @IsOptional()
  @Transform(({ value }) => parseBoolTransform(value))
  @IsBoolean()
  forEveryDepartmentAcrossBU?: boolean;

  @IsOptional()
  @Transform(({ value }) => parseBoolTransform(value))
  @IsBoolean()
  forAllDepartmentUnderSelectedBu?: boolean;

  @IsOptional()
  isActive?: boolean | string;

  @IsOptional()
  isDelete?: boolean | string;

  @IsOptional()
  updateApprovalLine?: boolean | string;

  @IsOptional()
  approvalLevels?: string;

  @IsOptional()
  defaultTypeFileId?: string | number | null;

  @IsOptional()
  defaultMainFileIndex?: string | number;
}
