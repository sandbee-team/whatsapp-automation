import { expect } from 'vitest';
import type { U3cHarness } from './internal-u3c-app-fixture.js';

/**
 * internal-u3c-support.ts (P28 Unit U3c) - `grantAndMint`, shared by
 * `internal-impersonation.integration.test.ts` and
 * `internal-impersonation-writes.integration.test.ts`. A sibling module
 * (never imported FROM a `*.test.ts` file, which would double-register that
 * file's own top-level `describe`/`beforeAll` blocks under vitest) - NOT
 * itself a test file.
 */

interface GrantBody {
  data: { grantId: string; clientId: string; scope: string; expiresAt: string };
}
interface MintBody {
  data: { accessToken: string; expiresAt: string; scope: string; grantId: string };
}

/** Grants a `metadata_only` impersonation (defaulting scope/duration) then mints its token in one call - the common setup every write/redaction/session test case needs. */
export async function grantAndMint(
  h: U3cHarness,
  staffId: string,
  clientId: string,
  overrides: Record<string, unknown> = {},
): Promise<{ grantId: string; accessToken: string }> {
  const grant = await h.sendInternal(
    'POST',
    `/internal/v1/clients/${clientId}/impersonation`,
    staffId,
    { reason: 'support ticket investigation', ...overrides },
  );
  expect(grant.statusCode).toBe(200);
  const grantId = (grant.json() as GrantBody).data.grantId;

  const mint = await h.sendInternal(
    'POST',
    `/internal/v1/impersonation/${grantId}/token`,
    staffId,
    { reason: 'mint session token for support ticket' },
  );
  expect(mint.statusCode).toBe(200);
  return { grantId, accessToken: (mint.json() as MintBody).data.accessToken };
}
