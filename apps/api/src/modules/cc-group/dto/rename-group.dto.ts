import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class RenameGroupDto {
  @IsString()
  @IsNotEmpty({ message: 'Group name is required' })
  @MaxLength(255)
  name!: string;
}
