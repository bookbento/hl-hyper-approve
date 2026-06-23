import { IsString, IsNotEmpty, IsArray, IsInt, IsOptional, IsIn } from 'class-validator';

export class BulkUpdateDto {
  @IsString()
  @IsNotEmpty()
  @IsIn(['replace', 'remove'])
  action!: 'replace' | 'remove';

  @IsInt()
  fromUserId!: number;

  @IsOptional()
  @IsInt()
  toUserId?: number;

  @IsArray()
  @IsInt({ each: true })
  groupIds!: number[];
}
