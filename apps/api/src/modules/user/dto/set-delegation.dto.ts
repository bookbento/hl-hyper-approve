import { IsOptional, IsInt, IsDateString } from 'class-validator';

export class SetDelegationDto {
  @IsOptional()
  @IsInt()
  delegatedToUserId?: number;

  @IsOptional()
  @IsDateString()
  delegationStartDate?: string;

  @IsOptional()
  @IsDateString()
  delegationEndDate?: string;
}
