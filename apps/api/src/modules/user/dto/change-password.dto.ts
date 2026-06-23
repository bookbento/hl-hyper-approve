import { IsString, IsNotEmpty } from 'class-validator';

export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty()
  current: string;

  @IsString()
  @IsNotEmpty()
  next: string;
}
