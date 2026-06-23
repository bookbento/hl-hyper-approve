import { IsOptional, IsInt, Min } from 'class-validator';
import { Transform } from 'class-transformer';

export class SetDefaultSignatureDto {
  /**
   * signatureId = number to set, null / "" to clear.
   * Accepts number, null, or "" (empty string from form body).
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Transform(({ value }: { value: unknown }) => {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isNaN(n) ? undefined : n;
  })
  signatureId?: number | null;
}
