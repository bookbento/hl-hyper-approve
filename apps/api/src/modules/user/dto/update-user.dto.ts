import { IsString, IsOptional, IsEmail } from 'class-validator';

export class UpdateUserDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  lastname?: string;

  @IsString()
  @IsOptional()
  nickname?: string;

  @IsEmail()
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  password?: string;

  @IsString()
  @IsOptional()
  role?: string;

  @IsString()
  @IsOptional()
  businessUnitName?: string;

  @IsString()
  @IsOptional()
  departmentName?: string;

  @IsOptional()
  businessUnitId?: number | string | null;

  @IsOptional()
  departmentId?: number | string | null;

  @IsString()
  @IsOptional()
  defaultSignatureText?: string;

  @IsOptional()
  clearImage?: string | boolean;
}
