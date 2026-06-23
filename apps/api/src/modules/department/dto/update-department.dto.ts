import { IsString, IsNotEmpty, IsOptional, IsInt, MaxLength } from 'class-validator';

export class UpdateDepartmentDto {
  @IsString()
  @IsNotEmpty({ message: 'Name is required' })
  @MaxLength(255)
  name!: string;

  @IsString()
  @IsNotEmpty({ message: 'Abbreviation is required' })
  @MaxLength(50)
  abbreviation!: string;

  @IsOptional()
  @IsInt()
  businessUnitId?: number | null;
}
