import nodemailer from 'nodemailer';
import { config } from './config.js';

/**
 * platform/mailer.ts (P04a Unit A3) - minimal SMTP port. In dev/test this
 * points at mailpit (127.0.0.1:1025 by default, see platform/config.ts); in
 * production it is whatever MAIL_HOST/MAIL_PORT resolve to.
 *
 * This is a PORT: services take a `sendVerificationEmail` function through
 * their ctx (see modules/identity/signup.service.ts) rather than importing
 * this module directly, so tests can inject a recording stub instead of
 * requiring mailpit to be running. Core invariant: a mailer call must NEVER
 * happen inside a DB transaction (see signup.service.ts - it is called only
 * after COMMIT, and its own failure is caught and logged, never thrown).
 */

export interface Mailer {
  sendVerificationEmail(to: string, verifyUrl: string): Promise<void>;
  /** M20b (P04a FIXB): promoted from `roles/api.ts`'s second, ad-hoc nodemailer transport. */
  sendLockoutEmail(to: string): Promise<void>;
  /** M20b (P04a FIXB): promoted from `roles/api.ts`'s second, ad-hoc nodemailer transport. */
  sendReuseDetectedEmail(to: string): Promise<void>;
  /** P28 U5 (item 1): the forgot-password flow's own send - `modules/identity/password.service.ts#forgotPassword` is the only caller. */
  sendPasswordResetEmail(to: string, resetUrl: string): Promise<void>;
  /**
   * P17 U3 (step 4): the notifications relay email leg's own send - ONE
   * message, `to` carrying every resolved recipient address (BCC-shaped: a
   * single send with multiple `to` entries, matching this port's existing
   * one-call-per-logical-notification shape rather than one call per
   * recipient) - `modules/notifications/dispatch/email.ts` is the only
   * caller. Reuses this SAME transport (never a second nodemailer instance).
   */
  sendNotificationEmail(to: string[], subject: string, body: string): Promise<void>;
}

export interface MailerConfig {
  mailHost: string;
  mailPort: number;
  mailFrom: string;
  /** Implicit TLS (port 465). `false` means plain or STARTTLS-upgraded (587, or dev's 1025). */
  mailSecure: boolean;
  /** Set together with `mailPassword` or not at all - `platform/config.ts` fails closed on a half-pair. */
  mailUser?: string | undefined;
  mailPassword?: string | undefined;
}

function configFrom(
  cfg: Pick<
    typeof config,
    'MAIL_HOST' | 'MAIL_PORT' | 'MAIL_FROM' | 'MAIL_SECURE' | 'MAIL_USER' | 'MAIL_PASSWORD'
  >,
): MailerConfig {
  return {
    mailHost: cfg.MAIL_HOST,
    mailPort: cfg.MAIL_PORT,
    mailFrom: cfg.MAIL_FROM,
    mailSecure: cfg.MAIL_SECURE,
    mailUser: cfg.MAIL_USER,
    mailPassword: cfg.MAIL_PASSWORD,
  };
}

/**
 * Creates a `Mailer` backed by a real SMTP transport.
 *
 * `auth` is attached ONLY when both a user and a password are configured, so
 * dev's anonymous mailpit keeps working unchanged while production points at
 * an authenticated relay (Gmail/Workspace with an app password:
 * `smtp.gmail.com`, port 465, `mailSecure: true`). `requireTLS` is set on the
 * non-implicit-TLS path so a STARTTLS relay can never silently fall back to
 * sending credentials in the clear; it is harmless on dev's plain SMTP because
 * no credentials are sent there at all.
 */
export function createMailer(mailerConfig: MailerConfig = configFrom(config)): Mailer {
  const hasAuth = Boolean(mailerConfig.mailUser && mailerConfig.mailPassword);
  const transport = nodemailer.createTransport({
    host: mailerConfig.mailHost,
    port: mailerConfig.mailPort,
    secure: mailerConfig.mailSecure,
    ...(hasAuth
      ? {
          auth: { user: mailerConfig.mailUser!, pass: mailerConfig.mailPassword! },
          ...(mailerConfig.mailSecure ? {} : { requireTLS: true }),
        }
      : {}),
  });

  return {
    async sendVerificationEmail(to: string, verifyUrl: string): Promise<void> {
      await transport.sendMail({
        from: mailerConfig.mailFrom,
        to,
        subject: 'Verify your email',
        text: `Verify your email: ${verifyUrl}`,
        html: `<p>Verify your email: <a href="${verifyUrl}">${verifyUrl}</a></p>`,
      });
    },
    async sendLockoutEmail(to: string): Promise<void> {
      await transport.sendMail({
        from: mailerConfig.mailFrom,
        to,
        subject: 'Your account was temporarily locked',
        text: 'Your account was temporarily locked due to repeated failed login attempts.',
      });
    },
    async sendReuseDetectedEmail(to: string): Promise<void> {
      await transport.sendMail({
        from: mailerConfig.mailFrom,
        to,
        subject: 'Security alert: session reuse detected',
        text: 'A revoked session token was reused. Every related session has been revoked - please sign in again.',
      });
    },
    async sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
      await transport.sendMail({
        from: mailerConfig.mailFrom,
        to,
        subject: 'Reset your password',
        text: `Reset your password: ${resetUrl}`,
        html: `<p>Reset your password: <a href="${resetUrl}">${resetUrl}</a></p>`,
      });
    },
    async sendNotificationEmail(to: string[], subject: string, body: string): Promise<void> {
      await transport.sendMail({
        from: mailerConfig.mailFrom,
        to,
        subject,
        text: body,
      });
    },
  };
}
