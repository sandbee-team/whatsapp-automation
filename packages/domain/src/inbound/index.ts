/**
 * inbound/index.ts (P21 Unit U2, step 3) - the module's public re-export
 * surface, per the layering convention every other `@wp/domain` submodule
 * follows (see `contacts/index.ts`).
 */
export { shouldIgnoreJid, type InboundScope, type IgnoreJidOptions } from './ignore-jid.js';
export {
  extractOptOutCandidateText,
  OptOutCandidateText,
  OPTOUT_CANDIDATE_MAX_CHARS,
} from './optout-text.js';
