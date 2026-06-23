import { IsString, IsNotEmpty, IsArray, IsInt, IsOptional, MaxLength } from 'class-validator';

export class CreateGroupDto {
  @IsString()
  @IsNotEmpty({ message: 'Group name is required' })
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  memberIds?: number[];
}
