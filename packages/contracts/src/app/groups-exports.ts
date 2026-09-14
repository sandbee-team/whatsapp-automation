/**
 * groups-exports.ts (P24 groups-messaging, Unit U2, step 4) - re-exports
 * everything from `./groups.js`, imported once from `packages/contracts/src/
 * index.ts` (that barrel sits at the `max-lines: 300` cap - same split idiom
 * as `broadcasts-exports.ts`).
 */
export * from './groups.js';
