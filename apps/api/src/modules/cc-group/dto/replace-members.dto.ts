import { IsArray, IsInt, IsOptional } from 'class-validator';

export class ReplaceMembersDto {
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  userIds?: number[];
}
