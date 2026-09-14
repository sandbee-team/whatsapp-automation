import { describe, expect, it } from 'vitest';
import { extractOptOutCandidateText, OptOutCandidateText } from './optout-text.js';

/**
 * optout-text-edge.test.ts (P21 E3 hardening) - adversarial inputs beyond
 * the sibling `optout-text.test.ts`: an over-depth wrapper chain, a
 * non-string `conversation`, a 100k-char caption (must still cap at 256
 * code points and never throw), the real Baileys `editedMessage` shape
 * wrapping a `protocolMessage.editedMessage`, and a surrogate pair sitting
 * exactly at the 256-code-point boundary (must never split a lone
 * surrogate).
 */
describe('extractOptOutCandidateText adversarial inputs', () => {
  it('a_deeply_nested_wrapper_chain_past_max_depth_yields_null', () => {
    // 6 levels of ephemeralMessage wrapping (MAX_UNWRAP_DEPTH is 5) - the
    // loop gives up before reaching the innermost conversation text.
    const deepMessage = {
      message: {
        ephemeralMessage: {
          message: {
            ephemeralMessage: {
              message: {
                ephemeralMessage: {
                  message: {
                    ephemeralMessage: {
                      message: {
                        ephemeralMessage: {
                          message: {
                            ephemeralMessage: {
                              message: { conversation: 'too deep to reach' },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    expect(extractOptOutCandidateText(deepMessage)).toBeNull();
  });

  it('conversation_as_a_number_is_not_treated_as_text', () => {
    const message = { message: { conversation: 12345 } };
    expect(extractOptOutCandidateText(message)).toBeNull();
  });

  it('a_100k_char_caption_caps_at_256_code_points_and_never_throws', () => {
    const hugeCaption = 'x'.repeat(100_000);
    const message = { message: { imageMessage: { caption: hugeCaption } } };

    let result: OptOutCandidateText | null = null;
    expect(() => {
      result = extractOptOutCandidateText(message);
    }).not.toThrow();

    expect(result).not.toBeNull();
    const text = (result as unknown as OptOutCandidateText).unwrapForKeywordMatching();
    expect(Array.from(text)).toHaveLength(256);
    expect(text).toBe('x'.repeat(256));
  });

  it('an_edited_message_wrapping_a_protocol_message_edited_message_extracts_the_new_text', () => {
    // FIXED (confirmed against baileys/WAProto/index.d.ts's
    // IProtocolMessage.editedMessage: proto.IMessage). Real Baileys shape:
    // editedMessage.message.protocolMessage.editedMessage carries the new
    // WAMessageContent. `protocolMessage`'s inner node lives at
    // `.editedMessage` (not `.message` like the other wrappers) -
    // `unwrapEnvelope` now checks this second wrapper "table" at every
    // depth, so the inner edited text IS reached through this exact
    // real-world shape.
    const message = {
      message: {
        editedMessage: {
          message: {
            protocolMessage: {
              editedMessage: { conversation: 'the edited text' },
            },
          },
        },
      },
    };
    const result = extractOptOutCandidateText(message);
    expect(result).not.toBeNull();
    expect((result as unknown as OptOutCandidateText).unwrapForKeywordMatching()).toBe(
      'the edited text',
    );
  });

  it('a_directly_wrapped_edited_message_conversation_is_extracted', () => {
    // The simpler shape this codebase's own fixture already covers
    // (editedMessage.message.conversation directly) - re-asserted here as
    // the contrast case to the protocolMessage-wrapped shape above.
    const message = {
      message: { editedMessage: { message: { conversation: 'direct edited text' } } },
    };
    const result = extractOptOutCandidateText(message);
    expect(result).not.toBeNull();
    expect((result as unknown as OptOutCandidateText).unwrapForKeywordMatching()).toBe(
      'direct edited text',
    );
  });

  it('a_surrogate_pair_straddling_the_256_boundary_never_produces_a_lone_surrogate', () => {
    // 255 ASCII chars + one emoji (a surrogate pair, 2 UTF-16 code units,
    // one code point) starting exactly at code-point index 255 - the cap
    // must take the WHOLE code point (256 total), never split the pair.
    const prefix = 'a'.repeat(255);
    const emoji = '\u{1F600}'; // one code point, a surrogate pair in UTF-16
    const longText = prefix + emoji + 'trailing content past the cap';
    const message = { message: { conversation: longText } };

    const result = extractOptOutCandidateText(message);
    expect(result).not.toBeNull();
    const text = (result as unknown as OptOutCandidateText).unwrapForKeywordMatching();
    const codePoints = Array.from(text);
    expect(codePoints).toHaveLength(256);
    expect(codePoints[255]).toBe(emoji);
    // No lone surrogate: re-encoding the code points must reproduce the
    // exact same string (a split pair would leave an unpaired surrogate
    // whose length arithmetic diverges).
    expect(text).toBe(codePoints.join(''));
    expect(text.length).toBe(255 + 2); // 255 BMP chars + 1 surrogate pair (2 UTF-16 units)
  });
});
