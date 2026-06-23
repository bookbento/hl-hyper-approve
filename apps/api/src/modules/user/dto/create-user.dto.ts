import {
  IsString,
  IsEmail,
  IsOptional,
  IsNotEmpty,
  MinLength,
  Matches,
} from 'class-validator';

export class CreateUserDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsOptional()
  lastname?: string;

  @IsString()
  @IsOptional()
  nickname?: string;

  /**
   * Email must be lowercase ASCII only — mirrors Express validation logic.
   */
  @IsEmail()
  @Matches(/^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/, {
    message: 'Email must be lowercase ASCII (a-z, 0-9 and ._%+- only)',
  })
  email: string;

  @IsString()
  @IsNotEmpty()
  password: string;

  @IsString()
  @IsNotEmpty()
  role: string;

  @IsString()
  @IsOptional()
  businessUnitName?: string;

  @IsString()
  @IsOptional()
  departmentName?: string;

  @IsOptional()
  businessUnitId?: number | string;

  @IsOptional()
  departmentId?: number | string;
}
