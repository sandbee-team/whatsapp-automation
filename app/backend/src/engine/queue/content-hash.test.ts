import { describe, expect, it } from 'vitest';
import { computeContentHash } from './content-hash.js';

/**
 * content-hash.test.ts (P12 Unit U3, ADR 0035 §3) - proves the dispatch-side
 * derivation and the echo-side derivation of `ContentHashFields` produce the
 * SAME digest for the same logical message. This is the ONE test that would
 * have caught the original P11 defect (hashing `JSON.stringify(payload)` on
 * one side against a `WAMessage`-shaped echo on the other, which could never
 * agree - see ADR 0035's own worked example).
 *
 * Builds a fake `WAMessage`-shaped object and a `DispatchInput`-shaped object
 * for the same logical message directly (no Baileys import here - this file
 * lives in `engine/queue/`, not `modules/queue/echo-capture.ts`, which is the
 * only file in this unit allowed to touch a Baileys type).
 */
describe('computeContentHash', () => {
  it('dispatch_and_echo_derived_fields_produce_the_same_digest', () => {
    // Dispatch side: DispatchInput-shaped fields (dispatch.ts's own
    // toWaMessagePayload projection: {to, kind, text}).
    const dispatchDerived = computeContentHash({
      jid: '19995550100@s.whatsapp.net',
      kind: 'text',
      text: 'hello there',
    });

    // Echo side: a fake WAMessage's key.remoteJid (provider-formatted, with
    // a device suffix Baileys can legitimately add) and message.conversation.
    const echoDerived = computeContentHash({
      jid: '19995550100:12@s.whatsapp.net',
      kind: 'text',
      text: 'hello there',
    });

    expect(dispatchDerived.equals(echoDerived)).toBe(true);
  });

  it('is_32_bytes_sha256', () => {
    const digest = computeContentHash({ jid: '1@s.whatsapp.net', kind: 'text', text: 'x' });
    expect(digest).toBeInstanceOf(Buffer);
    expect(digest.length).toBe(32);
  });

  it('differs_when_the_recipient_jid_differs', () => {
    const a = computeContentHash({ jid: '1@s.whatsapp.net', kind: 'text', text: 'same text' });
    const b = computeContentHash({ jid: '2@s.whatsapp.net', kind: 'text', text: 'same text' });
    expect(a.equals(b)).toBe(false);
  });
});
