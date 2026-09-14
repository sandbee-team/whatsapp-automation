import { z } from 'zod';

/**
 * platform/config-mail.ts (go-live 2026-09-14) - the `MAIL_*` half of
 * `platform/config.ts`, split into a sibling module for the 300-line cap (the
 * established split idiom). It is NOT a second place that reads
 * `process.env` - it exports a schema fragment that `config.ts` merges, so
 * that file remains the only reader.
 *
 * Dev points at mailpit, which accepts anonymous mail on :1025. Production
 * points at an authenticated relay; the first target is Gmail/Workspace with
 * an app password:
 *
 *   MAIL_HOST=smtp.gmail.com
 *   MAIL_PORT=465
 *   MAIL_SECURE=true
 *   MAIL_USER=<the sending address>
 *   MAIL_PASSWORD=<the 16-character app password, NEVER the account password>
 *   MAIL_FROM=<the same address, or an alias Gmail is allowed to send as>
 *
 * `mailer.ts` attaches SMTP auth only when BOTH user and password are set, so
 * dev keeps working untouched. `assertMailAuthPairing` below makes a
 * half-configured pair a boot failure rather than a silent one: a username
 * with no password authenticates as nobody, and every verification mail is
 * then refused by the relay - which the send path only logs, never throws.
 */
export const mailConfigShape = {
  MAIL_HOST: z.string().min(1).default('127.0.0.1'),
  MAIL_PORT: z.coerce.number().int().positive().default(1025),
  MAIL_FROM: z.string().min(1).default('no-reply@wp.local'),
  /** Implicit TLS (port 465). Leave false for STARTTLS (587) or plain dev SMTP (1025). */
  MAIL_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  MAIL_USER: z.string().min(1).optional(),
  MAIL_PASSWORD: z.string().min(1).optional(),
} as const;

/** Fail closed on a half-configured SMTP credential pair. */
export function assertMailAuthPairing(parsed: {
  MAIL_USER?: string | undefined;
  MAIL_PASSWORD?: string | undefined;
}): void {
  if (Boolean(parsed.MAIL_USER) !== Boolean(parsed.MAIL_PASSWORD)) {
    throw new Error('MAIL_USER and MAIL_PASSWORD must be set together, or both left unset.');
  }
}
