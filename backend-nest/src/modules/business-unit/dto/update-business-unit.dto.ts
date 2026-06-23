import { IsString, IsNotEmpty, IsOptional, MaxLength } from 'class-validator';

export class UpdateBusinessUnitDto {
  @IsString()
  @IsNotEmpty({ message: 'Name is required' })
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  abbreviation?: string;
}
