import type { TenantQueryable } from '@wp/db';

/**
 * contacts-tags-lookup.ts (P20 Unit U4, step 4) - `loadTagsByContactId`,
 * split out of `contacts.repo.ts` for the 300-line cap
 * (`session-worker-discovery-wiring.ts`'s own split idiom). Loads the tag
 * refs for a page of contact ids in ONE extra query (never N+1) - shared by
 * `contacts.repo.ts`'s single-load/list paths and `tags.repo.ts`'s
 * add/remove-link paths (both need the SAME post-write tag-ref shape).
 */

export interface ContactTagRefRow {
  id: string;
  name: string;
  color: string | null;
}

/** Returns a map keyed by contact id - empty map for an empty `contactIds` input (never a query with an empty `ANY($1)`). */
export async function loadTagsByContactId(
  tx: TenantQueryable,
  clientId: string,
  contactIds: string[],
): Promise<Map<string, ContactTagRefRow[]>> {
  const byContact = new Map<string, ContactTagRefRow[]>();
  if (contactIds.length === 0) return byContact;

  const result = await tx.query<{
    contact_id: string;
    id: string;
    name: string;
    color: string | null;
  }>(
    `SELECT l.contact_id, t.id, t.name::text AS name, t.color
       FROM contact_tag_links l
       JOIN contact_tags t ON t.id = l.tag_id AND t.client_id = $1
      WHERE l.client_id = $1 AND l.contact_id = ANY($2::uuid[])
      -- client_id = $1
      ORDER BY t.name`,
    [clientId, contactIds],
  );
  for (const row of result.rows) {
    const list = byContact.get(row.contact_id) ?? [];
    list.push({ id: row.id, name: row.name, color: row.color });
    byContact.set(row.contact_id, list);
  }
  return byContact;
}
