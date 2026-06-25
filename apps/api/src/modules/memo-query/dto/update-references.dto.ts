import { IsArray, IsNumber } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * DTO for PUT /api/memos/:id/references
 */
export class UpdateReferencesDto {
  @IsArray()
  @IsNumber({}, { each: true })
  @Type(() => Number)
  referenceIds!: number[];
}
