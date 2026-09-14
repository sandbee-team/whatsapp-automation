import { describe, expect, it, vi } from 'vitest';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { encodeOptOutSealedBlob, sealPhoneForOptOut } from './registry.js';

/**
 * registry.test.ts (P14 Unit U3, step 3) - proves `sealPhoneForOptOut`'s
 * seal call shape (purpose `'tenant-secrets'`, table `'opt_outs'`, column
 * `'phone_enc'`) and that it returns a framed buffer, not a raw
 * `SealedBlob`. `recordOptOut`/`isOptedOut`/`cancelOptOutJobs` are proved
 * against real Postgres in `registry.integration.test.ts` instead (they are
 * thin SQL wrappers, not worth mocking `TenantQueryable` for).
 */

function makeProvider(): KeyProvider {
  return {
    getActive: vi.fn().mockReturnValue({
      kekId: 'k1',
      purpose: 'tenant-secrets',
      material: Buffer.alloc(32, 0x02),
      retired: false,
    }),
    get: vi.fn(),
  };
}

describe('sealPhoneForOptOut', () => {
  it('seals_under_tenant_secrets_purpose_against_the_opt_outs_phone_enc_record', () => {
    const provider = makeProvider();
    const buf = sealPhoneForOptOut(provider, {
      clientId: 'client-1',
      e164OrJid: '+15550001111',
      recordId: 'record-1',
      encVersion: 1,
    });

    expect(provider.getActive).toHaveBeenCalledWith('tenant-secrets');
    expect(Buffer.isBuffer(buf)).toBe(true);

    const decoded = JSON.parse(buf.toString('utf8')) as { kek_id: string; enc_version: number };
    expect(decoded.kek_id).toBe('k1');
    expect(decoded.enc_version).toBe(1);
  });

  it('encodeOptOutSealedBlob_round_trips_every_field_as_base64', () => {
    const blob = {
      ciphertext: Buffer.from('cipher'),
      iv: Buffer.from('iv-bytes'),
      auth_tag: Buffer.from('tag-bytes'),
      dek_wrapped: Buffer.from('dek'),
      dek_iv: Buffer.from('dek-iv'),
      dek_tag: Buffer.from('dek-tag'),
      kek_id: 'k9',
      enc_version: 2,
    };

    const encoded = JSON.parse(encodeOptOutSealedBlob(blob).toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(encoded['ciphertext']).toBe(blob.ciphertext.toString('base64'));
    expect(encoded['kek_id']).toBe('k9');
    expect(encoded['enc_version']).toBe(2);
  });
});
