import type { TenantQueryable } from '@wp/db';
import { bindQueryParams, loadQuery } from '@wp/db';
import { provisioningRepo } from '../tenancy/index.js';
import { ContactNotFoundError } from './routes.js';

/**
 * erasure.ts (P20 Unit U6, step 7) - the per-contact erasure: a SOFT delete
 * + PII scrub (`db/queries/erase-contact.sql` - see its own header for the
 * exact column-level contract) plus its `audit_logs` companion row, both in
 * the CALLER's transaction. `opt_outs` is NEVER touched here (core
 * invariant: preserving an opt-out is how a recipient's "stop" request stays
 * honoured even after their contact record is erased) - the full DSAR
 * pipeline is P28, this is only the tenant-triggered per-contact erasure.
 */

export interface EraseContactActor {
  userId: string;
}

export interface EraseContactInput {
  clientId: string;
  contactId: string;
  actor: EraseContactActor;
  reason?: string;
}

export interface EraseContactResult {
  id: string;
  erasedAt: string;
}

interface RawEraseContactRow extends Record<string, unknown> {
  id: string;
  deleted_at: Date;
}

/** Zero matched rows (foreign, missing, or already-erased contact) throws `ContactNotFoundError`. */
export async function eraseContact(
  tx: TenantQueryable,
  input: EraseContactInput,
): Promise<EraseContactResult> {
  const query = await loadQuery('erase-contact');
  const params = bindQueryParams(query, {
    client_id: input.clientId,
    contact_id: input.contactId,
  });
  const result = await tx.query<RawEraseContactRow>(query.text, params);
  const row = result.rows[0];
  if (!row) {
    throw new ContactNotFoundError();
  }

  const auditMetadata = provisioningRepo.filterAuditMetadata({
    reason: input.reason ?? 'tenant_request',
  });
  await tx.query(
    `INSERT INTO audit_logs (client_id, actor_type, actor_user_id, action, target_type, target_id, metadata)
     VALUES ($1, 'user', $2, 'contacts.erase', 'contact', $3, $4)
     -- client_id = $1`,
    [
      input.clientId,
      input.actor.userId,
      input.contactId,
      auditMetadata ? JSON.stringify(auditMetadata) : null,
    ],
  );

  return { id: row.id, erasedAt: row.deleted_at.toISOString() };
}
