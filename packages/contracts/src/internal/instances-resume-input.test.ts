import { describe, expect, it } from 'vitest';
import { resumeInstanceInputSchema } from './instances.js';

/**
 * instances-resume-input.test.ts (P28 Unit U3b, step 5) - pins the RUNTIME
 * shape of `resumeInstanceInputSchema`.
 *
 * This schema is the one input in the internal contract set that mixes an
 * inline `.optional()` member with `.strict()`, and it is the one whose
 * declaration emit degraded (see its own doc comment). These cases assert
 * the runtime validator independently of that, so a future "fix" to the type
 * annotation can never silently change what the route actually accepts -
 * `clientId` is the TENANT SCOPE for every statement in the resume route, so
 * a schema that quietly dropped it would turn a tenant-scoped mutation into
 * an unscoped one.
 */

// A literal, not `randomUUID()`: `@wp/contracts` has no `@types/node` in its
// own tsconfig `types` list (it is a browser-and-server shared package).
const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const REASON = 'content review closed with no action needed';

describe('resumeInstanceInputSchema runtime shape', () => {
  it('accepts_client_id_and_reason_without_an_acknowledgement', () => {
    const parsed = resumeInstanceInputSchema.parse({ clientId: CLIENT_ID, reason: REASON });
    expect(parsed).toEqual({ clientId: CLIENT_ID, reason: REASON });
  });

  it('accepts_an_explicit_acknowledgement', () => {
    const parsed = resumeInstanceInputSchema.parse({
      clientId: CLIENT_ID,
      reason: REASON,
      acknowledgement: true,
    });
    expect(parsed).toEqual({ clientId: CLIENT_ID, reason: REASON, acknowledgement: true });
  });

  it('rejects_a_missing_client_id', () => {
    expect(resumeInstanceInputSchema.safeParse({ reason: REASON }).success).toBe(false);
  });

  it('rejects_a_non_uuid_client_id', () => {
    expect(
      resumeInstanceInputSchema.safeParse({ clientId: 'not-a-uuid', reason: REASON }).success,
    ).toBe(false);
  });

  it('rejects_an_unknown_field', () => {
    expect(
      resumeInstanceInputSchema.safeParse({ clientId: CLIENT_ID, reason: REASON, force: true })
        .success,
    ).toBe(false);
  });
});
