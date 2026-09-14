/**
 * @wp/utils - isomorphic helpers shared by every workspace: phone (E.164)
 * normalisation, timezone/window helpers, money (bigint minor units), cursor
 * encoding, string/format utilities. Dependency-light, no domain concepts,
 * safe to run in browser or Node.
 */
export const packageName = '@wp/utils' as const;

export { uuidv7 } from './uuidv7.js';
