/**
 * Fixture: adversarial-evasion pass for wp/no-plain-set and
 * wp/no-offset-pagination (session C2) - lowercase keyword variants. Both
 * selectors carry the `/i` flag, so a lowercase `set`/`offset` must still be
 * caught exactly like the uppercase form.
 */
export const badLowercaseSet = 'set search_path = tenant_1';
export const badLowercaseOffset = 'select * from message_jobs limit 20 offset 40';
