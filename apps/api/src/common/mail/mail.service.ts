import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import type { SentMessageInfo, Transporter } from 'nodemailer';

export type MailAttachment = {
  filename: string;
  /** attach from a file on disk */
  path?: string;
  /** attach from a Buffer/string */
  content?: Buffer | string;
  /** MIME type when using content */
  contentType?: string;
  cid?: string;
};

/**
 * SMTP mailer. Ported from backend/src/lib/mailer.ts.
 *
 * Env: SMTP_HOST, SMTP_PORT (587), SMTP_SECURE, SMTP_REQUIRE_TLS,
 *      SMTP_USER, SMTP_PASS, SMTP_FROM
 *
 * Sending never throws: a failed send is logged and ignored, same as the
 * Express mailer, so a mail outage can't fail the request that triggered it.
 */
@Injectable()
export class MailService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter = nodemailer.createTransport({
    host: process.env['SMTP_HOST'],
    port: Number(process.env['SMTP_PORT']) || 587,
    secure: process.env['SMTP_SECURE'] === 'true',
    requireTLS: process.env['SMTP_REQUIRE_TLS'] === 'true',
    auth: {
      user: process.env['SMTP_USER'],
      pass: process.env['SMTP_PASS'],
    },
    pool: true,
    maxConnections: 1,
    tls: { minVersion: 'TLSv1.2' },
  });

  onModuleInit(): void {
    // Startup connectivity check — log only, never block boot.
    if (!process.env['SMTP_HOST']) {
      this.logger.warn('SMTP_HOST is not set — emails will fail to send');
      return;
    }
    this.transporter
      .verify()
      .then(() => this.logger.log('SMTP ready'))
      .catch((err: Error) => this.logger.error(`SMTP verify failed: ${err.message}`));
  }

  onModuleDestroy(): void {
    this.transporter.close();
  }

  async sendEmail(
    to: string[],
    subject: string,
    text: string,
    html?: string,
    attachments?: MailAttachment[],
  ): Promise<SentMessageInfo | void> {
    try {
      return await this.transporter.sendMail({
        from: process.env['SMTP_FROM'],
        to,
        subject,
        text,
        html,
        attachments,
      });
    } catch (err) {
      this.logger.error(`email send error (ignored): ${(err as Error).message}`);
    }
  }
}
