import { IsBoolean } from 'class-validator';

export class UpdateNotificationPreferenceDto {
  @IsBoolean()
  emailEnabled: boolean;
}
