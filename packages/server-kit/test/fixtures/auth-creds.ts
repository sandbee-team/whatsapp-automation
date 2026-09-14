import { BufferJSON, initAuthCreds } from 'baileys';
import type { AuthenticationCreds } from 'baileys';
import type { JsonCodec } from '../../src/crypto/json-codec.js';

/**
 * The ONLY module in `@wp/server-kit` that imports `baileys` - it lives under
 * `test/`, outside `src/` (see `.dependency-cruiser.cjs`'s
 * `server-kit-src-never-imports-baileys` rule and this package's
 * `tsconfig.json`, whose `include: ["src"]` never compiles this file - it is
 * only ever executed by vitest). Every other file in this suite reaches
 * baileys only through this fixture.
 */

/** A fresh real `AuthenticationCreds` object, straight from Baileys' own `initAuthCreds()`. */
export function makeAuthCreds(): AuthenticationCreds {
  return initAuthCreds();
}

/**
 * The codec Baileys itself uses to serialise auth state to/from JSON
 * (`BufferJSON.replacer`/`.reviver`) - injected into `sealJson`/`openJson` so
 * `@wp/server-kit` never has to know Buffers need special handling; that
 * knowledge lives entirely in the caller-supplied codec.
 */
export const authStateCodec: JsonCodec = {
  replacer: BufferJSON.replacer,
  reviver: BufferJSON.reviver,
};
