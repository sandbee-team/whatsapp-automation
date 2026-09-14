import { describe, expect, it } from 'vitest';
import { uuidv7 } from './uuidv7.js';

const UUIDV7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

describe('uuidv7', () => {
  it('produces a well-formed uuidv7 string (version 7, RFC 4122 variant)', () => {
    const id = uuidv7();
    expect(id).toMatch(UUIDV7_PATTERN);
  });

  it('produces distinct values on successive calls', () => {
    const a = uuidv7();
    const b = uuidv7();
    expect(a).not.toBe(b);
  });

  it('embeds the injected millisecond timestamp in the leading 48 bits', () => {
    const fixedNow = new Date('2026-01-01T00:00:00.000Z').getTime();
    const id = uuidv7(() => fixedNow);
    const timestampHex = id.split('-').slice(0, 2).join('');
    expect(Number.parseInt(timestampHex, 16)).toBe(fixedNow);
  });
});
