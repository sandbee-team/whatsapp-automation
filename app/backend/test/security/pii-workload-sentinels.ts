import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileKeyProvider } from '@wp/server-kit/crypto';

/**
 * pii-workload-sentinels.ts (P25 U7 Part B) - the sentinel-value factory and
 * the opt-out-pepper key-ring fixture, split out of `pii-workload.ts` purely
 * for that file's own max-lines cap (same split idiom as `enqueue-http-auth-
 * helpers.ts`/`enqueue-test-support.ts`). NOT itself a test file (no
 * `.test.ts` suffix).
 */

export interface Sentinels {
  rand: string;
  email: string;
  phoneE164: string;
  phoneDigits: string;
  phoneJid: string;
  /** `tel:`-prefixed form (P25 C2 edge-case pass, hunt item 19b) - a URI-scheme phone form some UI/webhook renderers use, distinct from the bare E164/JID/digits forms above. */
  phoneTel: string;
  companyName: string;
  fullName: string;
  bodyText: string;
  qrPayload: string;
  extRef: string;
}

export function makeSentinels(tag: string): Sentinels {
  const rand = randomUUID();
  const phoneDigits = `9198${String(10000000 + Math.floor(Math.random() * 89999999))}`;
  return {
    rand,
    email: `pii-${tag}-${rand}@sentinel.invalid`,
    phoneE164: `+${phoneDigits}`,
    phoneDigits,
    phoneJid: `${phoneDigits}@s.whatsapp.net`,
    phoneTel: `tel:+${phoneDigits}`,
    companyName: `SentinelCo${rand}`,
    fullName: `Sentinel Person ${rand}`,
    bodyText: `SENTINEL_BODY_${rand} unique text`,
    qrPayload: `SENTINEL_QR_${rand}`,
    extRef: `SENTINEL_EXTREF_${rand}`,
  };
}

/** Every sentinel string form worth grepping for, across every tenant. */
export function allSentinelForms(sentinels: Sentinels[]): string[] {
  const forms: string[] = [];
  for (const s of sentinels) {
    forms.push(
      s.email,
      s.phoneE164,
      s.phoneDigits,
      s.phoneJid,
      s.phoneTel,
      s.companyName,
      s.fullName,
      s.bodyText,
      s.qrPayload,
      s.extRef,
    );
  }
  return forms;
}

function makeOptoutPepperRing(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wp-pii-workload-ring-'));
  const path = join(dir, 'key-ring.json');
  const material = Buffer.alloc(32, 0x0c).toString('base64');
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      active: {
        session: 'k1',
        'tenant-secrets': 'k2',
        'user-secrets': 'k3',
        'optout-pepper': 'k4',
        'api-key-pepper': 'k5',
      },
      keys: {
        k1: { purpose: 'session', material, created_at: '2026-01-01T00:00:00.000Z' },
        k2: { purpose: 'tenant-secrets', material, created_at: '2026-01-01T00:00:00.000Z' },
        k3: { purpose: 'user-secrets', material, created_at: '2026-01-01T00:00:00.000Z' },
        k4: { purpose: 'optout-pepper', material, created_at: '2026-01-01T00:00:00.000Z' },
        k5: { purpose: 'api-key-pepper', material, created_at: '2026-01-01T00:00:00.000Z' },
      },
    }),
    'utf8',
  );
  return path;
}

export function makeWorkloadKeyProvider(): FileKeyProvider {
  return new FileKeyProvider({
    ringPath: makeOptoutPepperRing(),
    mountedPurposes: ['optout-pepper', 'tenant-secrets'],
  });
}
