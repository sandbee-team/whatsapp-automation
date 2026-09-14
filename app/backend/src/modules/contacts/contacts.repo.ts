import type { TenantDb, TenantQueryable } from '@wp/db';
import { decodeCursor, encodeCursor } from './contacts-cursor.js';
import { loadTagsByContactId } from './contacts-tags-lookup.js';
import {
  CONTACT_COLUMNS,
  mapContactRow,
  type ContactRow,
  type RawContactRow,
} from './contacts-row.js';

/**
 * contacts.repo.ts (P20 Unit U4, step 4) - `contacts` SQL-only repo:
 * `loadContact`/`listContacts` (reads). Every statement repeats
 * `client_id = $n` (core invariant 4; `check-tenant-scope` scans string
 * literals for this). KEYSET ONLY (canon,
 * `packages/contracts/src/contacts.ts`'s own doc comment): the list
 * statement orders `(updated_at DESC, id DESC)` - there is no `OFFSET`
 * anywhere in this file. Writes (`createContact`/`updateContact`), the
 * cursor codec, the admission-limit guard, and the tag-ref lookup are split
 * into sibling modules (300-line cap) - see `contacts-write.ts`/
 * `contacts-cursor.ts`/`contacts-limits.ts`/`contacts-tags-lookup.ts`.
 * Re-exported here so every existing `from './contacts.repo.js'` import
 * keeps working unchanged.
 */

export { InvalidCursorError } from './contacts-cursor.js';
export {
  ContactLimitReachedError,
  resolveEffectiveMaxContacts,
  countLiveContacts,
} from './contacts-limits.js';
export {
  ContactValidationError,
  ContactDuplicatePhoneError,
  createContact,
  updateContact,
  type CreateContactRepoInput,
  type UpdateContactRepoInput,
} from './contacts-write.js';
export type { ContactRow } from './contacts-row.js';

/** Loads a single live contact (with its tags) - `undefined` when foreign or missing (route maps that to 404, never 403). */
export async function loadContact(
  tx: TenantQueryable,
  clientId: string,
  id: string,
): Promise<ContactRow | undefined> {
  const result = await tx.query<RawContactRow>(
    `SELECT ${CONTACT_COLUMNS} FROM contacts
      WHERE client_id = $1 AND id = $2 AND deleted_at IS NULL
      -- client_id = $1`,
    [clientId, id],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  const tagsByContact = await loadTagsByContactId(tx, clientId, [row.id]);
  return mapContactRow(row, tagsByContact.get(row.id) ?? []);
}

/** Escapes `%`, `_`, and `\` in a user-supplied ILIKE fragment before wrapping it in `%...%`. */
function escapeLikeFragment(raw: string): string {
  return raw.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export interface ListContactsRepoInput {
  clientId: string;
  limit: number;
  cursor?: string;
  q?: string;
  tagId?: string;
  optOutState?: 'none' | 'opted_out';
}

export interface ListContactsRepoResult {
  items: ContactRow[];
  nextCursor: string | null;
}

/** Keyset list, one extra row fetched beyond `limit` (present iff there is a next page - never a second COUNT query). No `OFFSET` anywhere. */
export async function listContacts(
  tenantDb: TenantDb,
  input: ListContactsRepoInput,
): Promise<ListContactsRepoResult> {
  const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;

  return tenantDb.withTenant(input.clientId, async (tx) => {
    const conditions: string[] = [];
    const params: unknown[] = [input.clientId];

    if (input.q) {
      params.push(`%${escapeLikeFragment(input.q)}%`);
      conditions.push(`display_name ILIKE $${params.length} ESCAPE '\\'`);
    }
    if (input.tagId) {
      params.push(input.tagId);
      conditions.push(
        `EXISTS (SELECT 1 FROM contact_tag_links l WHERE l.client_id = $1 AND l.contact_id = c.id AND l.tag_id = $${params.length})`,
      );
    }
    if (input.optOutState) {
      params.push(input.optOutState);
      conditions.push(`opt_out_state = $${params.length}`);
    }
    if (cursor) {
      params.push(cursor.updatedAt, cursor.id);
      conditions.push(
        `(updated_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
      );
    }

    params.push(input.limit + 1);
    const extraConditions = conditions.length ? ` AND ${conditions.join(' AND ')}` : '';
    const sql = `SELECT c.id, c.phone_e164, c.wa_jid, c.addressing_mode, c.display_name, c.first_name,
                        c.last_name, c.attrs, c.source, c.consent_basis, c.opt_out_state, c.opted_out_at,
                        c.last_inbound_at, c.last_outbound_at, c.created_at, c.updated_at
                   FROM contacts c
                  WHERE c.client_id = $1 AND c.deleted_at IS NULL${extraConditions}
                  -- client_id = $1
                  ORDER BY c.updated_at DESC, c.id DESC
                  LIMIT $${params.length}`;
    const result = await tx.query<RawContactRow>(sql, params);

    const hasMore = result.rows.length > input.limit;
    const page = hasMore ? result.rows.slice(0, input.limit) : result.rows;
    const tagsByContact = await loadTagsByContactId(
      tx,
      input.clientId,
      page.map((r) => r.id),
    );
    const items = page.map((row) => mapContactRow(row, tagsByContact.get(row.id) ?? []));
    const last = items.at(-1);
    const nextCursor =
      hasMore && last ? encodeCursor({ updatedAt: last.updatedAt, id: last.id }) : null;

    return { items, nextCursor };
  });
}
