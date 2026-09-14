import './../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it, vi } from 'vitest';

/**
 * mailer.test.ts (go-live 2026-09-14) - pins how the SMTP transport is
 * constructed, because the production relay is Gmail/Workspace with an app
 * password and a mis-shaped transport fails in the one place the code never
 * throws: `sendVerificationEmail`'s caller catches and logs, so a wrong
 * transport is a SILENT outage (nobody can verify an email, nobody sees why).
 *
 * The nodemailer module is mocked so nothing opens a socket.
 */

type TransportOptions = Record<string, unknown>;

const createTransport = vi.fn((options: TransportOptions) => ({
  // The options are the subject under test - they are read back through
  // `lastTransportOptions()`, not used to build a real transport.
  options,
  sendMail: vi.fn(async () => undefined),
}));

/** The options nodemailer was constructed with, typed - `mock.calls[0]` is `[TransportOptions]`. */
function lastTransportOptions(): TransportOptions {
  const call = createTransport.mock.calls.at(-1);
  if (!call) throw new Error('createTransport was never called');
  return call[0];
}
vi.mock('nodemailer', () => ({ default: { createTransport } }));

const { createMailer } = await import('./mailer.js');

const DEV = {
  mailHost: '127.0.0.1',
  mailPort: 1025,
  mailFrom: 'no-reply@wp.local',
  mailSecure: false,
} as const;

describe('createMailer transport shape', () => {
  it('sends anonymously when no credentials are configured (dev mailpit)', () => {
    createTransport.mockClear();
    createMailer({ ...DEV });

    expect(createTransport).toHaveBeenCalledTimes(1);
    const options = lastTransportOptions();
    expect(options.host).toBe('127.0.0.1');
    expect(options.port).toBe(1025);
    expect(options.secure).toBe(false);
    // No auth key at all - mailpit accepts anonymous mail, and an `auth`
    // object with undefined members makes nodemailer attempt AUTH anyway.
    expect('auth' in options).toBe(false);
    expect('requireTLS' in options).toBe(false);
  });

  it('authenticates over implicit TLS for Gmail (port 465)', () => {
    createTransport.mockClear();
    createMailer({
      mailHost: 'smtp.gmail.com',
      mailPort: 465,
      mailFrom: 'ops@example.com',
      mailSecure: true,
      mailUser: 'ops@example.com',
      mailPassword: 'abcd efgh ijkl mnop',
    });

    const options = lastTransportOptions();
    expect(options.secure).toBe(true);
    expect(options.auth).toEqual({ user: 'ops@example.com', pass: 'abcd efgh ijkl mnop' });
    // Implicit TLS is already encrypted; requireTLS is a STARTTLS-only concern.
    expect('requireTLS' in options).toBe(false);
  });

  it('requires STARTTLS before sending credentials on a non-TLS port (587)', () => {
    createTransport.mockClear();
    createMailer({
      mailHost: 'smtp.gmail.com',
      mailPort: 587,
      mailFrom: 'ops@example.com',
      mailSecure: false,
      mailUser: 'ops@example.com',
      mailPassword: 'abcd efgh ijkl mnop',
    });

    const options = lastTransportOptions();
    expect(options.secure).toBe(false);
    // The point of the case: credentials must never go out in the clear if the
    // relay declines to upgrade the connection.
    expect(options.requireTLS).toBe(true);
    expect(options.auth).toEqual({ user: 'ops@example.com', pass: 'abcd efgh ijkl mnop' });
  });

  it('does not authenticate when only one half of the pair is set', () => {
    createTransport.mockClear();
    // `platform/config.ts` rejects this pairing at boot; this asserts the
    // mailer is independently fail-safe rather than sending a half-credential.
    createMailer({ ...DEV, mailUser: 'ops@example.com' });

    const options = lastTransportOptions();
    expect('auth' in options).toBe(false);
  });
});
