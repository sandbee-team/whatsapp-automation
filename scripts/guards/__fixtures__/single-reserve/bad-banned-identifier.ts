// Fixture: a planted occurrence of the banned identifier, spelled out as a
// real, contiguous token here on purpose (this file lives under
// __fixtures__/, which CONTENT_EXCLUSIONS excludes from the real repo
// scan, so it can never trip the live CI run of check-single-reserve.ts -
// only this guard's own test feeds it directly to scanBannedIdentifier()).
export const INTERIM_MIN_GAP_MS = 250;
