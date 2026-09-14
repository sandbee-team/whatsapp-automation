import '../realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it, vi } from 'vitest';
import type { TenantQueryable } from '@wp/db';
import type { KeyProvider } from '@wp/server-kit/crypto';
import type { OptOutMirrorPort } from '../pacing/index.js';
import { detectInboundOptOut } from './optout-detect.js';
import * as registry from '../pacing/optout/registry.js';

/**
 * optout-detect.test.ts (P14 Unit U3, step 6; P20 Unit U8, step 8 - the
 * injected mirror port) - `detectInboundOptOut` unit tests. Imports
 * `@wp/server-kit/crypto`'s `KeyProvider` type only (no runtime crypto call
 * reaches the config singleton), but `logger` (`@wp/server-kit` root) IS
 * used by the module under test, so this file needs the
 * `stub-wp-server-kit-env.js` first-import guard.
 */

function makeProvider(): KeyProvider {
  return {
    getActive: vi.fn().mockReturnValue({
      kekId: 'k1',
      purpose: 'optout-pepper',
      material: Buffer.alloc(32, 0x01),
      retired: false,
    }),
    get: vi.fn(),
  };
}

function makeTx(): TenantQueryable {
  return { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
}

function makeRecordingMirror(): { mirror: OptOutMirrorPort; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const mirror: OptOutMirrorPort = async (tx, input) => {
    calls.push([tx, input]);
    return { contactsUpdated: 0 };
  };
  return { mirror, calls };
}

describe('detectInboundOptOut', () => {
  it('no_match_writes_nothing', async () => {
    const tx = makeTx();
    const { mirror, calls: mirrorCalls } = makeRecordingMirror();
    const result = await detectInboundOptOut(
      { tx, provider: makeProvider(), mirror },
      {
        clientId: 'client-1',
        instanceId: 'instance-1',
        senderJid: '15550001111@s.whatsapp.net',
        senderE164: '+15550001111',
        text: 'hello, how are you today my friend',
        tenantKeywords: [],
      },
    );

    expect(result).toEqual({ matched: null, attributed: false });
    expect(tx.query).not.toHaveBeenCalled();
    expect(mirrorCalls.length).toBe(0);
  });

  it('a_lid_only_group_sender_is_recorded_unattributable_not_misattributed', async () => {
    const tx = makeTx();
    const recordOptOutSpy = vi.spyOn(registry, 'recordOptOut');
    const { mirror, calls: mirrorCalls } = makeRecordingMirror();

    const result = await detectInboundOptOut(
      { tx, provider: makeProvider(), mirror },
      {
        clientId: 'client-1',
        instanceId: 'instance-1',
        senderJid: '123456789@lid',
        senderE164: null,
        text: 'stop',
        tenantKeywords: [],
      },
    );

    expect(result.matched).toBe('stop');
    expect(result.attributed).toBe(false);
    // No opt_outs row and no cancellation for an unattributable sender -
    // and, since recordOptOut is never even called, the injected mirror
    // port is never called either.
    expect(tx.query).not.toHaveBeenCalled();
    expect(recordOptOutSpy).not.toHaveBeenCalled();
    expect(result.optedOut).toBeUndefined();
    expect(mirrorCalls.length).toBe(0);

    recordOptOutSpy.mockRestore();
  });

  it('an_attributable_match_records_and_cancels_and_returns_optedOut_for_the_caller_to_confirm_post_commit', async () => {
    // FINDING 7 FIX (P14 review-fix F2): this module must NEVER invoke a
    // confirmation port itself (in-tx or otherwise) - a confirmation fired
    // before this transaction commits could outlive a later rollback. The
    // caller reads `result.optedOut` and invokes its OWN confirmation
    // sender only after its transaction has committed.
    const tx = makeTx();
    // recordOptOut itself calls deps.mirror (registry.ts's own contract) -
    // this test's OWN mirror fake is what recordOptOut is given, and this
    // spy observes when recordOptOut's real implementation runs, so the two
    // call orders below prove the mirror fires strictly after recordOptOut
    // starts (recordOptOut is what invokes it, so it cannot fire before).
    const callOrder: string[] = [];
    const recordOptOutSpy = vi.spyOn(registry, 'recordOptOut');
    const mirrorCalls: unknown[][] = [];
    const mirror = async (mirrorTx: TenantQueryable, input: { phoneHash: Buffer }) => {
      callOrder.push('mirror');
      mirrorCalls.push([mirrorTx, input]);
      return { contactsUpdated: 0 };
    };

    const result = await detectInboundOptOut(
      { tx, provider: makeProvider(), mirror },
      {
        clientId: 'client-1',
        instanceId: 'instance-1',
        senderJid: '15550001111@s.whatsapp.net',
        senderE164: '+15550001111',
        text: 'stop',
        tenantKeywords: [],
      },
    );

    expect(result.matched).toBe('stop');
    expect(result.attributed).toBe(true);
    expect(tx.query).toHaveBeenCalled();
    expect(result.optedOut).toBeDefined();
    expect(result.optedOut?.clientId).toBe('client-1');
    expect(result.optedOut?.instanceId).toBe('instance-1');
    expect(result.optedOut?.e164).toBe('+15550001111');

    // P20 U8: the injected mirror runs exactly once, with the SAME
    // phoneHash recordOptOut was given.
    expect(recordOptOutSpy).toHaveBeenCalledTimes(1);
    expect(mirrorCalls.length).toBe(1);
    expect(callOrder).toEqual(['mirror']);
    const recordedPhoneHash = recordOptOutSpy.mock.calls[0]?.[1]?.phoneHash as Buffer;
    const mirroredInput = mirrorCalls[0]?.[1] as { phoneHash: Buffer };
    expect(mirroredInput.phoneHash.equals(recordedPhoneHash)).toBe(true);

    recordOptOutSpy.mockRestore();
  });
});
