/**
 * Banned marketing/product-copy claims (English + Hinglish), verbatim.
 * Source: `MASTER-PLAN.md` (~line 821) + `.memory/research/2026-08-25-v1-
 * design-repo-structure.md` §2.3. `scripts/check-copy.ts` (P00 step 9, not
 * yet wired) scans every user-facing string for a case-insensitive
 * substring match against this list - WP never claims to be "ban-proof" or
 * to guarantee delivery/avoidance of provider restrictions (invariant 6:
 * honest product, no restriction-avoidance promises).
 *
 * Capacity/session-cost bracket figures (P10 Unit U7, ADR 0016 / ADR 0018
 * §8) are deliberately NOT added here: `check-copy.ts` scans the whole
 * shipped tree (`SCAN_GLOBS`), including internal engineering comments/tests
 * (e.g. `app/backend/src/engine/fleet/drain.ts`,
 * `session-cost-feedback.test.ts`) where such figures legitimately appear -
 * banning them tree-wide would false-positive on real, non-tenant-facing
 * code. That narrower ban (tenant-facing trees only) lives in
 * `scripts/check-capacity-gate.ts`'s own `BANNED_CAPACITY_FIGURES` list.
 */
export const BANNED_CLAIMS: readonly string[] = Object.freeze([
  'ban-proof',
  'ban proof',
  "won't get blocked",
  'will not get banned',
  'avoids WhatsApp blocking',
  '100% safe',
  'guaranteed delivery',
  'unlimited sending',
  'avoid ban',
  'instant bulk',
  'ban nahi hoga',
  'block nahi hoga',
  'बैन नहीं होगा',
  'ब्लॉक नहीं होगा',
  '100% सुरक्षित',
  'गारंटीड डिलीवरी',
]);
