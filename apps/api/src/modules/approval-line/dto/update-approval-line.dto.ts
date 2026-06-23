import { IsString, IsOptional, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApprovalUserDto, ApprovalLevelDto } from './create-approval-line.dto';

export class UpdateApprovalLineDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ApprovalLevelDto)
  levels!: ApprovalLevelDto[];
}
