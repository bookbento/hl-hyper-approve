import { IsString, IsNotEmpty, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class ApprovalUserDto {
  id?: number;
  isSigReq?: boolean;
  slotType?: string;
  roleDescription?: string;
  approvalRequirement?: string;
}

export class ApprovalLevelDto {
  @IsArray()
  users!: ApprovalUserDto[];
}

export class CreateApprovalLineDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ApprovalLevelDto)
  levels!: ApprovalLevelDto[];
}
