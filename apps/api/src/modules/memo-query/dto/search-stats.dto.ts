import { IsOptional, IsBoolean } from 'class-validator';

/**
 * DTO for POST /api/memos/search/stats
 */
export class SearchStatsDto {
  @IsOptional()
  @IsBoolean()
  forceRefresh?: boolean;
}
