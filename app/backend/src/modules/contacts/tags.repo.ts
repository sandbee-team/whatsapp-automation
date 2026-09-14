import type { TenantQueryable } from '@wp/db';
import { loadTagsByContactId } from './contacts-tags-lookup.js';

/**
 * tags.repo.ts (P20 Unit U4, step 4) - `contact_tags`/`contact_tag_links`
 * SQL-only repo: tag CRUD plus the add/remove-link operations that keep
 * `contact_tags.contact_count` maintained in the SAME transaction as the
 * link write (never a separate, driftable counter update). Every statement
 * repeats `client_id = $n` (core invariant 4). A foreign contact or tag id
 * resolves to a 404 (RLS + explicit predicate), never a 403 - enforced by
 * the caller checking the returned row/array length.
 */

export class TagNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor() {
    super('No such contact tag.');
    this.name = 'TagNotFoundError';
  }
}

export interface ContactTagRow {
  id: string;
  name: string;
  color: string | null;
  contactCount: number;
  createdAt: string;
}

interface RawTagRow extends Record<string, unknown> {
  id: string;
  name: string;
  color: string | null;
  contact_count: number;
  created_at: Date;
}

function mapTagRow(row: RawTagRow): ContactTagRow {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    contactCount: row.contact_count,
    createdAt: row.created_at.toISOString(),
  };
}

const TAG_COLUMNS = `id, name::text AS name, color, contact_count, created_at`;

export async function listContactTags(
  tx: TenantQueryable,
  clientId: string,
): Promise<ContactTagRow[]> {
  const result = await tx.query<RawTagRow>(
    `SELECT ${TAG_COLUMNS} FROM contact_tags WHERE client_id = $1 ORDER BY name`,
    [clientId],
  );
  return result.rows.map(mapTagRow);
}

/** Duplicate name -> a raw Postgres `23505` on `contact_tags_client_id_name_key`, mapped by the route (never pre-checked here). */
export async function createContactTag(
  tx: TenantQueryable,
  input: { clientId: string; name: string; color?: string; createdByUserId: string },
): Promise<ContactTagRow> {
  const result = await tx.query<RawTagRow>(
    `INSERT INTO contact_tags (client_id, name, color, created_by_user_id)
     VALUES ($1, $2, $3, $4)
     -- client_id = $1
     RETURNING ${TAG_COLUMNS}`,
    [input.clientId, input.name, input.color ?? null, input.createdByUserId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('createContactTag: no row returned from INSERT');
  return mapTagRow(row);
}

export async function patchContactTag(
  tx: TenantQueryable,
  input: { clientId: string; id: string; name?: string; color?: string | null },
): Promise<ContactTagRow | undefined> {
  const setClauses: string[] = [];
  const params: unknown[] = [input.clientId, input.id];

  if (input.name !== undefined) {
    params.push(input.name);
    setClauses.push(`name = $${params.length}`);
  }
  if (input.color !== undefined) {
    params.push(input.color);
    setClauses.push(`color = $${params.length}`);
  }
  if (setClauses.length === 0) {
    const existing = await tx.query<RawTagRow>(
      `SELECT ${TAG_COLUMNS} FROM contact_tags WHERE client_id = $1 AND id = $2`,
      [input.clientId, input.id],
    );
    const row = existing.rows[0];
    return row ? mapTagRow(row) : undefined;
  }

  const result = await tx.query<RawTagRow>(
    `UPDATE contact_tags SET ${setClauses.join(', ')}
      WHERE client_id = $1 AND id = $2
      -- client_id = $1
    RETURNING ${TAG_COLUMNS}`,
    params,
  );
  const row = result.rows[0];
  return row ? mapTagRow(row) : undefined;
}

/** Deletes a tag - the FK `ON DELETE CASCADE` removes its `contact_tag_links` rows. Returns `false` when the tag was foreign or missing. */
export async function deleteContactTag(
  tx: TenantQueryable,
  clientId: string,
  id: string,
): Promise<boolean> {
  const result = await tx.query(
    `DELETE FROM contact_tags WHERE client_id = $1 AND id = $2 -- client_id = $1`,
    [clientId, id],
  );
  return (result.rowCount ?? 0) > 0;
}

export interface SetContactTagsInput {
  clientId: string;
  contactId: string;
  add?: string[];
  remove?: string[];
}

/**
 * Adds/removes tag links for one contact, maintaining `contact_count` in
 * the SAME transaction as the link write. Throws `TagNotFoundError` when
 * the contact itself is foreign/missing, OR when any add-tag id does not
 * belong to this tenant (never a partial application against a foreign
 * tag). A `remove` of a tag with no existing link is a no-op (idempotent).
 */
export async function setContactTags(
  tx: TenantQueryable,
  input: SetContactTagsInput,
): Promise<Map<string, { id: string; name: string; color: string | null }[]>> {
  const contactCheck = await tx.query(
    `SELECT 1 FROM contacts WHERE client_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [input.clientId, input.contactId],
  );
  if (contactCheck.rowCount === 0) {
    throw new TagNotFoundError();
  }

  const addIds = input.add ?? [];
  if (addIds.length > 0) {
    const tagCheck = await tx.query<{ id: string }>(
      `SELECT id FROM contact_tags WHERE client_id = $1 AND id = ANY($2::uuid[])`,
      [input.clientId, addIds],
    );
    if (tagCheck.rows.length !== addIds.length) {
      throw new TagNotFoundError();
    }
    const inserted = await tx.query<{ tag_id: string }>(
      `INSERT INTO contact_tag_links (client_id, tag_id, contact_id)
       SELECT $1, t, $3 FROM unnest($2::uuid[]) t
       -- client_id = $1
       ON CONFLICT DO NOTHING
       RETURNING tag_id`,
      [input.clientId, addIds, input.contactId],
    );
    for (const row of inserted.rows) {
      await tx.query(
        `UPDATE contact_tags SET contact_count = contact_count + 1 WHERE client_id = $1 AND id = $2`,
        [input.clientId, row.tag_id],
      );
    }
  }

  const removeIds = input.remove ?? [];
  if (removeIds.length > 0) {
    const removed = await tx.query<{ tag_id: string }>(
      `DELETE FROM contact_tag_links
        WHERE client_id = $1 AND contact_id = $2 AND tag_id = ANY($3::uuid[])
        -- client_id = $1
      RETURNING tag_id`,
      [input.clientId, input.contactId, removeIds],
    );
    for (const row of removed.rows) {
      await tx.query(
        `UPDATE contact_tags SET contact_count = GREATEST(contact_count - 1, 0) WHERE client_id = $1 AND id = $2`,
        [input.clientId, row.tag_id],
      );
    }
  }

  return loadTagsByContactId(tx, input.clientId, [input.contactId]);
}
