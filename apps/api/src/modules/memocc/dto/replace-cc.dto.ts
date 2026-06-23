import { IsArray, IsNumber } from 'class-validator';
import { Type } from 'class-transformer';

export class ReplaceCcDto {
  @IsArray()
  @IsNumber({}, { each: true })
  @Type(() => Number)
  userIds: number[] = [];

  @IsArray()
  @IsNumber({}, { each: true })
  @Type(() => Number)
  groupIds: number[] = [];
}
