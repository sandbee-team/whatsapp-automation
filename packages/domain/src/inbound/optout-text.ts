/**
 * optout-text.ts (P21 Unit U2, step 3) - the browser-pure, in-memory-only
 * carrier for text extracted from an inbound message, plus the ONE extractor
 * that produces it. This is the only text-extraction path in the codebase
 * (core invariant / ADR 0021 PII discipline): nothing else may read
 * `conversation`/`extendedTextMessage.text`/captions off a raw provider
 * message.
 *
 * `OptOutCandidateText` is deliberately NOT a string: it must never be
 * assignable where a string is expected (query parameter, log line, jsonb
 * payload), so a reviewer can grep every read site via the one named unwrap
 * method and structurally rule out an accidental persistence/log write. The
 * `toJSON` override makes `JSON.stringify` throw even when nested inside
 * another object (`JSON.stringify` calls `toJSON` on every object it
 * encounters, including nested ones).
 */

export const OPTOUT_CANDIDATE_MAX_CHARS = 256;

const NEVER_SERIALISE_MESSAGE =
  'OptOutCandidateText is in-memory only and must never be serialised';

export class OptOutCandidateText {
  private constructor(private readonly value: string) {}

  static fromPlainText(text: string): OptOutCandidateText | null {
    const trimmed = text.trim();
    if (trimmed === '') {
      return null;
    }
    const truncated = Array.from(trimmed).slice(0, OPTOUT_CANDIDATE_MAX_CHARS).join('');
    return new OptOutCandidateText(truncated);
  }

  /** The ONE way to read it, named so a reviewer can grep every read site. */
  unwrapForKeywordMatching(): string {
    return this.value;
  }

  toJSON(): never {
    throw new Error(NEVER_SERIALISE_MESSAGE);
  }

  toString(): string {
    return '[OptOutCandidateText]';
  }

  get length(): number {
    return Array.from(this.value).length;
  }
}

/**
 * Wrapper keys whose inner node lives at `.message` (the common Baileys
 * envelope shape).
 */
const WRAPPER_KEYS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'deviceSentMessage',
  'editedMessage',
] as const;

/**
 * `protocolMessage` is a distinct real Baileys shape
 * (`IEditedMessageProtocolMessage`, confirmed against
 * `baileys/WAProto/index.d.ts`'s `IProtocolMessage.editedMessage`): its
 * inner message-shaped node lives at `.editedMessage`, not `.message` - the
 * real wire shape is `editedMessage.message.protocolMessage.editedMessage`.
 * `protocolMessage` is therefore a second wrapper "table" with its own
 * inner-field name, checked after the `.message`-shaped wrappers at each
 * depth.
 */
const PROTOCOL_MESSAGE_KEY = 'protocolMessage';
const PROTOCOL_MESSAGE_INNER_FIELD = 'editedMessage';

const CAPTION_KEYS = ['imageMessage', 'videoMessage', 'documentMessage'] as const;

const MAX_UNWRAP_DEPTH = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Unwraps known envelope wrappers (loop until no wrapper matches, capped at MAX_UNWRAP_DEPTH). */
function unwrapEnvelope(message: unknown): unknown {
  let current = message;
  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth += 1) {
    if (!isRecord(current)) {
      return current;
    }
    const record = current;
    const wrapperKey = WRAPPER_KEYS.find((key) => isRecord(record[key]));
    if (wrapperKey !== undefined) {
      const wrapper = record[wrapperKey] as { message?: unknown };
      current = wrapper.message;
      continue;
    }
    if (isRecord(record[PROTOCOL_MESSAGE_KEY])) {
      const protocolMessage = record[PROTOCOL_MESSAGE_KEY] as Record<string, unknown>;
      current = protocolMessage[PROTOCOL_MESSAGE_INNER_FIELD];
      continue;
    }
    return record;
  }
  return current;
}

function readPlainText(message: Record<string, unknown>): string | null {
  if (typeof message.conversation === 'string') {
    return message.conversation;
  }

  const extendedText = message.extendedTextMessage;
  if (isRecord(extendedText) && typeof extendedText.text === 'string') {
    return extendedText.text;
  }

  for (const captionKey of CAPTION_KEYS) {
    const captionCarrier = message[captionKey];
    if (isRecord(captionCarrier) && typeof captionCarrier.caption === 'string') {
      return captionCarrier.caption;
    }
  }

  return null;
}

/**
 * Duck-types the Baileys `WAMessage` shape as `unknown` (no baileys import -
 * domain purity). Reads ONLY `message.message`, its known wrapper chain, and
 * the text/caption fields listed in `readPlainText`. Never returns, exposes
 * or references `rawMessage`, `key`, `pushName`, `participant` or the input
 * object itself.
 */
export function extractOptOutCandidateText(message: unknown): OptOutCandidateText | null {
  if (!isRecord(message)) {
    return null;
  }

  const unwrapped = unwrapEnvelope(message.message);
  if (!isRecord(unwrapped)) {
    return null;
  }

  const text = readPlainText(unwrapped);
  if (text === null) {
    return null;
  }

  return OptOutCandidateText.fromPlainText(text);
}
