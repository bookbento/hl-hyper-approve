import { IsString, MinLength } from 'class-validator';

export class ChangeFirstTimePasswordDto {
  @IsString()
  @MinLength(6)
  newPassword: string;
}
