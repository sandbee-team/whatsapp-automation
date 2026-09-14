/**
 * contacts/index.ts (P20 Unit U2, step 3) - the module's public re-export
 * surface, per the layering convention every other `@wp/domain` submodule
 * follows.
 */
export { normaliseE164, waJidFromE164, type E164Reason, type E164Result } from './phone.js';
export {
  normalizeJidUser,
  normaliseJid,
  type AddressingMode,
  type JidResult,
  type NormaliseJidOptions,
} from './jid.js';
