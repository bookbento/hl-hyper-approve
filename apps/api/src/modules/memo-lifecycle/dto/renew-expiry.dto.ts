/**
 * RenewExpiryDto — NestJS DTO for POST /api/memos/:id/renew-expiry
 */

import { IsString, IsOptional, IsIn } from 'class-validator';

export class RenewExpiryDto {
  @IsString()
  expiresAt!: string;

  @IsOptional()
  @IsIn(['Draft', 'Processing'])
  targetStatus?: 'Draft' | 'Processing';
}
