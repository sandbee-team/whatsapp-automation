import { describe, expect, it, vi } from 'vitest';
import type { WAMessage } from 'baileys';
import type { TenantDb, TenantQueryable } from '@wp/db';
import { computeContentHash } from '../../engine/queue/content-hash.js';
import { captureEchoIfFromMe, type CaptureEchoDeps } from './echo-capture.js';

/**
 * echo-capture.test.ts (P12 Unit U3, step 5) - unit-tests the pure
 * derivation/fail-safe logic against a FAKE `TenantDb` (no real Postgres) -
 * the `ON CONFLICT ... WHERE message_id IS NULL` write-once guarantee and
 * the actual insert shape are proved by the integration suite
 * (`reconciler.integration.test.ts`'s echo-capture case), since this repo
 * has no in-memory DB fake.
 */

function fakeTenantDb(query: ReturnType<typeof vi.fn>): TenantDb {
  return {
    withTenant: async <T>(_clientId: string, fn: (tx: TenantQueryable) => Promise<T>) =>
      fn({ query } as unknown as TenantQueryable),
  };
}

function buildDeps(query: ReturnType<typeof vi.fn>): {
  deps: CaptureEchoDeps;
  warn: ReturnType<typeof vi.fn>;
  incrementEchoCaptureFailed: ReturnType<typeof vi.fn>;
} {
  const warn = vi.fn();
  const incrementEchoCaptureFailed = vi.fn();
  const deps: CaptureEchoDeps = {
    tenantDb: fakeTenantDb(query),
    clientId: 'client-1',
    instanceId: 'instance-1',
    logger: { warn },
    metrics: { incrementEchoCaptureFailed },
  };
  return { deps, warn, incrementEchoCaptureFailed };
}

describe('captureEchoIfFromMe', () => {
  it('is_a_no_op_for_a_non_fromMe_message', async () => {
    const query = vi.fn();
    const { deps } = buildDeps(query);
    const message = {
      key: { fromMe: false, id: 'wamid-1', remoteJid: '1@s.whatsapp.net' },
      message: { conversation: 'hi' },
    } as unknown as WAMessage;

    await captureEchoIfFromMe(message, deps);

    expect(query).not.toHaveBeenCalled();
  });

  it('records_a_plain_conversation_text_echo_with_the_dispatch_side_hash', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const { deps } = buildDeps(query);
    const message = {
      key: { fromMe: true, id: 'wamid-2', remoteJid: '19995550100@s.whatsapp.net' },
      message: { conversation: 'hello there' },
    } as unknown as WAMessage;

    await captureEchoIfFromMe(message, deps);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO message_wa_ids');
    expect(sql).toContain('ON CONFLICT');
    expect(sql).toContain('WHERE message_wa_ids.message_id IS NULL');
    expect(params[2]).toBe('wamid-2');
    const expectedHash = computeContentHash({
      jid: '19995550100@s.whatsapp.net',
      kind: 'text',
      text: 'hello there',
    });
    expect((params[3] as Buffer).equals(expectedHash)).toBe(true);
  });

  it('unwraps_a_deviceSentMessage_and_uses_its_destinationJid', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const { deps } = buildDeps(query);
    const message = {
      key: { fromMe: true, id: 'wamid-3', remoteJid: 'own-jid@s.whatsapp.net' },
      message: {
        deviceSentMessage: {
          destinationJid: '19995550100@s.whatsapp.net',
          message: { extendedTextMessage: { text: 'linked device text' } },
        },
      },
    } as unknown as WAMessage;

    await captureEchoIfFromMe(message, deps);

    const [, params] = query.mock.calls[0] as [string, unknown[]];
    const expectedHash = computeContentHash({
      jid: '19995550100@s.whatsapp.net',
      kind: 'text',
      text: 'linked device text',
    });
    expect((params[3] as Buffer).equals(expectedHash)).toBe(true);
  });

  it('derives_media_kind_and_caption_text_from_an_image_message', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const { deps } = buildDeps(query);
    const message = {
      key: { fromMe: true, id: 'wamid-4', remoteJid: '1@s.whatsapp.net' },
      message: { imageMessage: { caption: 'look at this', url: 'https://example.invalid/x' } },
    } as unknown as WAMessage;

    await captureEchoIfFromMe(message, deps);

    const [, params] = query.mock.calls[0] as [string, unknown[]];
    const expectedHash = computeContentHash({
      jid: '1@s.whatsapp.net',
      kind: 'media',
      text: 'look at this',
    });
    expect((params[3] as Buffer).equals(expectedHash)).toBe(true);
  });

  it('a_captionless_media_message_hashes_to_the_empty_text_field', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const { deps } = buildDeps(query);
    const message = {
      key: { fromMe: true, id: 'wamid-5', remoteJid: '1@s.whatsapp.net' },
      message: { imageMessage: { url: 'https://example.invalid/x' } },
    } as unknown as WAMessage;

    await captureEchoIfFromMe(message, deps);

    const [, params] = query.mock.calls[0] as [string, unknown[]];
    const expectedHash = computeContentHash({ jid: '1@s.whatsapp.net', kind: 'media', text: '' });
    expect((params[3] as Buffer).equals(expectedHash)).toBe(true);
  });

  it('skips_and_counts_a_message_with_no_key_id_without_throwing', async () => {
    const query = vi.fn();
    const { deps, incrementEchoCaptureFailed } = buildDeps(query);
    const message = {
      key: { fromMe: true, remoteJid: '1@s.whatsapp.net' },
      message: { conversation: 'hi' },
    } as unknown as WAMessage;

    await expect(captureEchoIfFromMe(message, deps)).resolves.toBeUndefined();

    expect(query).not.toHaveBeenCalled();
    expect(incrementEchoCaptureFailed).toHaveBeenCalledTimes(1);
  });

  it('skips_and_counts_a_message_with_no_content_without_throwing', async () => {
    const query = vi.fn();
    const { deps, incrementEchoCaptureFailed } = buildDeps(query);
    const message = {
      key: { fromMe: true, id: 'wamid-6', remoteJid: '1@s.whatsapp.net' },
    } as unknown as WAMessage;

    await captureEchoIfFromMe(message, deps);

    expect(query).not.toHaveBeenCalled();
    expect(incrementEchoCaptureFailed).toHaveBeenCalledTimes(1);
  });

  it('a_thrown_db_error_is_caught_counted_and_never_rethrown', async () => {
    const query = vi.fn().mockRejectedValue(new Error('boom'));
    const { deps, incrementEchoCaptureFailed, warn } = buildDeps(query);
    const message = {
      key: { fromMe: true, id: 'wamid-7', remoteJid: '1@s.whatsapp.net' },
      message: { conversation: 'hi' },
    } as unknown as WAMessage;

    await expect(captureEchoIfFromMe(message, deps)).resolves.toBeUndefined();

    expect(incrementEchoCaptureFailed).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    // Redacted: never logs the message body/jid/phone number.
    const [warnMsg] = warn.mock.calls[0] as [string];
    expect(warnMsg).not.toContain('hi');
    expect(warnMsg).not.toContain('1@s.whatsapp.net');
  });

  it('NOTE_8_a_pg_shaped_error_with_row_values_in_its_message_is_never_logged_verbatim', async () => {
    // A pg driver error's `.message`/`.detail`/`.where` can carry the
    // failing row's actual values depending on the failure mode - this
    // simulates that shape (a unique-violation-style error whose message
    // embeds a raw value) and asserts the log line contains NEITHER the
    // row value NOR the raw error message text, only a bounded
    // name/code shape.
    const pgShapedError = Object.assign(
      new Error(
        'duplicate key value violates unique constraint "x" DETAIL: Key (wa_msg_id)=(wamid.super-secret-row-value) already exists.',
      ),
      {
        name: 'error',
        code: '23505',
      },
    );
    const query = vi.fn().mockRejectedValue(pgShapedError);
    const { deps, incrementEchoCaptureFailed, warn } = buildDeps(query);
    const message = {
      key: { fromMe: true, id: 'wamid-9', remoteJid: '1@s.whatsapp.net' },
      message: { conversation: 'hi' },
    } as unknown as WAMessage;

    await expect(captureEchoIfFromMe(message, deps)).resolves.toBeUndefined();

    expect(incrementEchoCaptureFailed).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    const [warnMsg] = warn.mock.calls[0] as [string];
    expect(warnMsg).not.toContain('super-secret-row-value');
    expect(warnMsg).not.toContain('wamid.super-secret-row-value');
    expect(warnMsg).not.toContain('DETAIL');
    // A bounded, non-PII shape: error name/constructor plus the pg code.
    expect(warnMsg).toContain('23505');
  });

  it('a_message_with_no_resolvable_jid_is_skipped_and_counted', async () => {
    const query = vi.fn();
    const { deps, incrementEchoCaptureFailed } = buildDeps(query);
    const message = {
      key: { fromMe: true, id: 'wamid-8' },
      message: { conversation: 'hi' },
    } as unknown as WAMessage;

    await captureEchoIfFromMe(message, deps);

    expect(query).not.toHaveBeenCalled();
    expect(incrementEchoCaptureFailed).toHaveBeenCalledTimes(1);
  });
});
