import { IsArray, IsBoolean, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class SlotDto {
  @IsNumber()
  @Type(() => Number)
  level: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  userId?: number | null;

  @IsOptional()
  @IsString()
  slotType?: string | null;

  @IsOptional()
  @IsBoolean()
  isSigReq?: boolean;

  @IsOptional()
  @IsString()
  roleDescription?: string | null;

  @IsOptional()
  @IsString()
  approvalRequirement?: string;
}

export class UpdateApproversForLineDto {
  @IsOptional()
  @IsString()
  lineName?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SlotDto)
  slots: SlotDto[];
}
