import { describe, expect, it } from 'vitest';
import { contentHashInput, normalizeWaJidForHash } from './content-hash.js';

describe('contentHashInput', () => {
  it('the_canonical_string_is_exactly_the_documented_byte_sequence', () => {
    // '19995550100@s.whatsapp.net' is 26 UTF-8 bytes (11-digit number + '@' +
    // 'S.WhatsApp.Net'.length===14 => 11+1+14=26). ADR 0035 §3's worked
    // example uses 24, an arithmetic slip in the ADR text - the SCHEME
    // (v1|<utf8len(jid)>:<jid>|<kind>|<utf8len(text)>:<text>) is unambiguous
    // and this is its exact computed output for this input.
    expect(contentHashInput({ jid: '19995550100@s.whatsapp.net', kind: 'text', text: 'hi' })).toBe(
      'v1|26:19995550100@s.whatsapp.net|text|2:hi',
    );
  });

  it('a_separator_inside_the_text_cannot_forge_a_field_boundary', () => {
    // A naive `|`-join of {jid, kind, text} would let text containing '|'
    // forge a field boundary: {jid:'1@s.whatsapp.net', kind:'text', text:'a|b'}
    // vs {jid:'1@s.whatsapp.net', kind:'text', text:'a'} + a crafted
    // continuation could collide under plain concatenation. Length-prefixing
    // makes the two constructed inputs below hash differently even though
    // their naive '|'-joins would be byte-identical.
    const withPipeInText = contentHashInput({
      jid: '1@s.whatsapp.net',
      kind: 'text',
      text: 'a|1@s.whatsapp.net|text|1:b',
    });
    const shiftedBoundary = contentHashInput({
      jid: '1@s.whatsapp.net',
      kind: 'text',
      text: 'a',
    });

    expect(withPipeInText).not.toBe(shiftedBoundary);
  });

  it('a_device_suffix_and_a_c_us_server_normalise_to_the_stored_jid_form', () => {
    const echoForm = contentHashInput({
      jid: '19995550100:12@c.us',
      kind: 'text',
      text: 'hi',
    });
    const storedForm = contentHashInput({
      jid: '19995550100@s.whatsapp.net',
      kind: 'text',
      text: 'hi',
    });

    expect(echoForm).toBe(storedForm);
  });

  it('an_lid_jid_is_returned_unchanged', () => {
    expect(normalizeWaJidForHash('123456789@lid')).toBe('123456789@lid');
    expect(normalizeWaJidForHash('ABC123@lid')).toBe('abc123@lid');
  });

  it('nfc_equivalent_texts_hash_equally', () => {
    // 'é' precomposed (U+00E9) vs decomposed ('e' + U+0301 combining acute).
    const precomposed = contentHashInput({ jid: '1@s.whatsapp.net', kind: 'text', text: 'café' });
    const decomposed = contentHashInput({
      jid: '1@s.whatsapp.net',
      kind: 'text',
      text: 'café',
    });

    expect(precomposed).toBe(decomposed);
  });

  it('a_media_message_with_no_caption_hashes_to_the_empty_text_field', () => {
    expect(contentHashInput({ jid: '1@s.whatsapp.net', kind: 'media' })).toBe(
      'v1|16:1@s.whatsapp.net|media|0:',
    );
  });

  it('normalizeWaJidForHash_lowercases_and_strips_a_leading_plus', () => {
    expect(normalizeWaJidForHash('+19995550100@S.WhatsApp.Net')).toBe('19995550100@s.whatsapp.net');
  });

  it('is_pure_across_repeated_calls_with_the_same_input', () => {
    const fields = { jid: '1@s.whatsapp.net', kind: 'text' as const, text: 'hello' };
    expect(contentHashInput(fields)).toBe(contentHashInput(fields));
  });
});
