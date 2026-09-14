import { describe, expect, it } from 'vitest';
import {
  extractOptOutCandidateText,
  OPTOUT_CANDIDATE_MAX_CHARS,
  OptOutCandidateText,
} from './optout-text.js';

interface Fixture {
  name: string;
  message: unknown;
  expectedText: string | null;
}

const SENTINEL_RAW = { rawMessage: 'SENTINEL_RAW_BUFFER', pushName: 'SENTINEL_NAME' };

const FIXTURES: Fixture[] = [
  {
    name: 'conversation',
    message: { message: { conversation: 'hello there' }, ...SENTINEL_RAW },
    expectedText: 'hello there',
  },
  {
    name: 'extendedText',
    message: {
      message: { extendedTextMessage: { text: 'extended hi' } },
      ...SENTINEL_RAW,
    },
    expectedText: 'extended hi',
  },
  {
    name: 'imageCaption',
    message: { message: { imageMessage: { caption: 'img caption' } }, ...SENTINEL_RAW },
    expectedText: 'img caption',
  },
  {
    name: 'videoCaption',
    message: { message: { videoMessage: { caption: 'vid caption' } }, ...SENTINEL_RAW },
    expectedText: 'vid caption',
  },
  {
    name: 'documentCaption',
    message: { message: { documentMessage: { caption: 'doc caption' } }, ...SENTINEL_RAW },
    expectedText: 'doc caption',
  },
  {
    name: 'ephemeralWrappedText',
    message: {
      message: { ephemeralMessage: { message: { conversation: 'ephemeral hi' } } },
      ...SENTINEL_RAW,
    },
    expectedText: 'ephemeral hi',
  },
  {
    name: 'viewOnceWrappedImageCaption',
    message: {
      message: {
        viewOnceMessage: { message: { imageMessage: { caption: 'view once caption' } } },
      },
      ...SENTINEL_RAW,
    },
    expectedText: 'view once caption',
  },
  {
    name: 'viewOnceV2WrappedText',
    message: {
      message: {
        viewOnceMessageV2: { message: { conversation: 'view once v2' } },
      },
      ...SENTINEL_RAW,
    },
    expectedText: 'view once v2',
  },
  {
    name: 'viewOnceV2ExtensionWrappedText',
    message: {
      message: {
        viewOnceMessageV2Extension: { message: { conversation: 'view once v2 ext' } },
      },
      ...SENTINEL_RAW,
    },
    expectedText: 'view once v2 ext',
  },
  {
    name: 'documentWithCaptionWrappedText',
    message: {
      message: {
        documentWithCaptionMessage: { message: { conversation: 'doc with caption wrapper' } },
      },
      ...SENTINEL_RAW,
    },
    expectedText: 'doc with caption wrapper',
  },
  {
    name: 'deviceSentWrappedText',
    message: {
      message: { deviceSentMessage: { message: { conversation: 'device sent hi' } } },
      ...SENTINEL_RAW,
    },
    expectedText: 'device sent hi',
  },
  {
    name: 'editedWrappedText',
    message: {
      message: { editedMessage: { message: { conversation: 'edited hi' } } },
      ...SENTINEL_RAW,
    },
    expectedText: 'edited hi',
  },
  {
    name: 'audio',
    message: { message: { audioMessage: {} }, ...SENTINEL_RAW },
    expectedText: null,
  },
  {
    name: 'sticker',
    message: { message: { stickerMessage: {} }, ...SENTINEL_RAW },
    expectedText: null,
  },
  {
    name: 'reaction',
    message: { message: { reactionMessage: { text: 'ignored' } }, ...SENTINEL_RAW },
    expectedText: null,
  },
  {
    name: 'protocol',
    message: { message: { protocolMessage: {} }, ...SENTINEL_RAW },
    expectedText: null,
  },
  {
    name: 'contact',
    message: { message: { contactMessage: {} }, ...SENTINEL_RAW },
    expectedText: null,
  },
  {
    name: 'location',
    message: { message: { locationMessage: {} }, ...SENTINEL_RAW },
    expectedText: null,
  },
  {
    name: 'poll',
    message: { message: { pollCreationMessage: {} }, ...SENTINEL_RAW },
    expectedText: null,
  },
  {
    name: 'noMessage',
    message: { ...SENTINEL_RAW },
    expectedText: null,
  },
  {
    name: 'messageNull',
    message: { message: null, ...SENTINEL_RAW },
    expectedText: null,
  },
];

describe('extractOptOutCandidateText', () => {
  it('the_text_extractor_never_returns_raw_message_json', () => {
    for (const fixture of FIXTURES) {
      const result = extractOptOutCandidateText(fixture.message);

      if (fixture.expectedText === null) {
        expect(result, `fixture ${fixture.name} expected null`).toBeNull();
      } else {
        expect(result, `fixture ${fixture.name} expected non-null`).not.toBeNull();
        expect((result as OptOutCandidateText).unwrapForKeywordMatching()).toBe(
          fixture.expectedText,
        );
      }

      if (result === null) {
        expect(() => JSON.stringify(result)).not.toThrow();
      } else {
        expect(() => JSON.stringify(result)).toThrow();
        expect(() => JSON.stringify({ wrapped: result })).toThrow();
        expect(String(result)).toBe('[OptOutCandidateText]');
        for (const key of Object.keys(result)) {
          expect(key.toLowerCase()).not.toContain('raw');
        }
      }
    }
  });

  it('a_long_text_is_capped_at_256_code_points', () => {
    const emoji = '😀';
    const longText = 'a'.repeat(500) + emoji.repeat(500);
    const candidate = OptOutCandidateText.fromPlainText(longText);

    expect(candidate).not.toBeNull();
    const text = (candidate as OptOutCandidateText).unwrapForKeywordMatching();
    const codePoints = Array.from(text);

    expect(codePoints.length).toBe(OPTOUT_CANDIDATE_MAX_CHARS);
    expect(codePoints).toEqual(Array.from(longText).slice(0, OPTOUT_CANDIDATE_MAX_CHARS));
    // No lone surrogate at the end: re-encoding via Array.from and joining
    // must reproduce the same string length as the code point join (a lone
    // trailing high surrogate would produce a length mismatch / U+FFFD).
    expect(text).toBe(codePoints.join(''));
    expect((candidate as OptOutCandidateText).length).toBe(OPTOUT_CANDIDATE_MAX_CHARS);
  });

  it('an_empty_or_whitespace_text_yields_null', () => {
    expect(OptOutCandidateText.fromPlainText('')).toBeNull();
    expect(OptOutCandidateText.fromPlainText('   ')).toBeNull();
    expect(OptOutCandidateText.fromPlainText('\t\n  ')).toBeNull();
  });

  it('the_candidate_type_is_not_assignable_to_string', () => {
    const candidate = OptOutCandidateText.fromPlainText('stop') as OptOutCandidateText;

    // @ts-expect-error - OptOutCandidateText must never be assignable to string
    const asString: string = candidate;
    expect(typeof asString).toBe('object');
  });
});
