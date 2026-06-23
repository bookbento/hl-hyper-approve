import { IsArray, IsInt } from 'class-validator';

export class UpdateBuAccessDto {
  @IsArray()
  @IsInt({ each: true })
  businessUnitIds: number[];
}
