/**
 * audience.ts (P23 Unit U4, step 4; widened P24 Unit U6, step 9) - the
 * audience JSON shape shared by the snapshot ceiling-count query and every
 * snapshot batch: `{ kind: 'contacts', tagIds?, contactIds? } | { kind:
 * 'groups', groupIds? }` (`@wp/contracts`'s `broadcastAudienceSchema`, U2).
 * Every array defaults to empty (never `undefined` bound into a
 * `= ANY($1::uuid[])` parameter - an empty array matches nothing/everything
 * per each query's own convention, `undefined` would bind NULL and match
 * nothing, so explicit empty arrays keep the SQL param types unambiguous).
 */
export interface ContactsAudienceJson {
  kind: 'contacts';
  tagIds?: string[];
  contactIds?: string[];
}

export interface GroupsAudienceJson {
  kind: 'groups';
  groupIds?: string[];
}

export type BroadcastAudienceJson = ContactsAudienceJson | GroupsAudienceJson;

export interface AudienceMatchParams {
  contactIds: string[];
  tagIds: string[];
}

/** Normalises a stored `campaigns.audience` jsonb value into the two arrays every contacts audience-matching query binds. Callers must check `audience.kind === 'contacts'` first (P24 Unit U6). */
export function audienceMatchParams(audience: ContactsAudienceJson): AudienceMatchParams {
  return {
    contactIds: audience.contactIds ?? [],
    tagIds: audience.tagIds ?? [],
  };
}

/** `groupIds` normalised to an explicit empty array - empty means every non-left group on the instance (see `snapshot-groups-batch.sql`'s own header). */
export function groupsAudienceMatchParams(audience: GroupsAudienceJson): { groupIds: string[] } {
  return { groupIds: audience.groupIds ?? [] };
}
