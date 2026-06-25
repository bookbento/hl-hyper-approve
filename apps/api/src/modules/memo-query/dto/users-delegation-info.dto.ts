import { IsArray, IsNumber } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * DTO for POST /api/memos/users-delegation-info
 */
export class UsersDelegationInfoDto {
  @IsArray()
  @IsNumber({}, { each: true })
  @Type(() => Number)
  userIds!: number[];
}
