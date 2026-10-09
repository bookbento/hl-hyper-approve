import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service';
import { EmailPreferenceService } from './email-preference.service';

@Global()
@Module({
  providers: [MailService, EmailPreferenceService],
  exports: [MailService, EmailPreferenceService],
})
export class MailModule {}
