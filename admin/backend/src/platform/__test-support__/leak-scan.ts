/**
 * __test-support__/leak-scan.ts (P28 Unit U4, step 7) - the PII leak scanner
 * used by `platform-read.integration.test.ts`. Split out of that file purely
 * for the `max-lines: 300` cap (core-invariants.md's sanctioned split
 * idiom); it is a test helper, never imported by shipped code.
 *
 * It scans an admin response TWO ways, because either alone is insufficient:
 *  - by KEY NAME, which catches a projection that added a forbidden column
 *    under its natural name;
 *  - by seeded secret VALUE (the caller's job), which catches a leak that
 *    renamed the field to something innocuous.
 */

/** Any response KEY matching this is a projection leak. */
export const FORBIDDEN_KEY_PATTERN =
  /(phone|e164|jid|body|payload|text|caption|external_?ref|full_?name|email|label|recipient)/i;

/**
 * The ONE allowed exception, and it is not a weakening:
 * `plan_limits.max_broadcast_recipients` is a plan CEILING - an integer
 * describing how many recipients a plan permits per broadcast. It contains
 * no recipient, and it belongs to the platform's own plan catalogue rather
 * than to any tenant. It is listed EXPLICITLY, rather than by loosening the
 * pattern to something like "recipient not preceded by max_", so that a
 * genuinely recipient-bearing field can never slip in behind a broadened
 * regex.
 */
export const ALLOWED_KEY_EXCEPTIONS: ReadonlySet<string> = new Set(['maxBroadcastRecipients']);

/** Every key name appearing anywhere in `value`, at any depth. */
export function collectKeys(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
    return keys;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      keys.push(key);
      collectKeys(nested, keys);
    }
  }
  return keys;
}

/** The forbidden key names present in `parsedBody` - `[]` means no leak by key name. */
export function findForbiddenKeys(parsedBody: unknown): string[] {
  return collectKeys(parsedBody).filter(
    (key) => FORBIDDEN_KEY_PATTERN.test(key) && !ALLOWED_KEY_EXCEPTIONS.has(key),
  );
}
