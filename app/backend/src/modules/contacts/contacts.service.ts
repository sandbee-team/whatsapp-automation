import type { TenantDb } from '@wp/db';
import type { KeyProvider } from '@wp/server-kit/crypto';
import type { ConsentBasis } from '@wp/domain';
import {
  createContact,
  updateContact,
  loadContact,
  listContacts,
  type ContactRow,
  type ListContactsRepoInput,
  type ListContactsRepoResult,
} from './contacts.repo.js';
import { setContactTags } from './tags.repo.js';
import type { ContactTagRefRow } from './contacts-tags-lookup.js';

/**
 * contacts.service.ts (P20 Unit U4, step 4) - the thin business-logic layer
 * routes.ts calls: each function opens exactly one `tenantDb.withTenant`
 * transaction and delegates to `contacts.repo.ts`/`tags.repo.ts`. Kept
 * separate from the repo layer so a future business rule (e.g. an outbox
 * event on create) has a single seam to land in without touching SQL.
 */

export interface CreateContactServiceInput {
  clientId: string;
  createdByUserId: string;
  phone: string;
  defaultCountry?: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
  attrs?: Record<string, unknown>;
  consentBasis?: ConsentBasis;
  tagIds?: string[];
  keyProvider: KeyProvider;
}

export async function createContactService(
  tenantDb: TenantDb,
  input: CreateContactServiceInput,
): Promise<ContactRow> {
  return tenantDb.withTenant(input.clientId, async (tx) => {
    const contact = await createContact(tx, {
      clientId: input.clientId,
      createdByUserId: input.createdByUserId,
      phone: input.phone,
      defaultCountry: input.defaultCountry,
      displayName: input.displayName,
      firstName: input.firstName,
      lastName: input.lastName,
      attrs: input.attrs,
      consentBasis: input.consentBasis,
      keyProvider: input.keyProvider,
    });

    if (input.tagIds && input.tagIds.length > 0) {
      const tagsByContact = await setContactTags(tx, {
        clientId: input.clientId,
        contactId: contact.id,
        add: input.tagIds,
      });
      return { ...contact, tags: tagsByContact.get(contact.id) ?? [] };
    }
    return contact;
  });
}

export interface UpdateContactServiceInput {
  clientId: string;
  id: string;
  displayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  attrs?: Record<string, unknown>;
}

export async function updateContactService(
  tenantDb: TenantDb,
  input: UpdateContactServiceInput,
): Promise<ContactRow | undefined> {
  return tenantDb.withTenant(input.clientId, (tx) =>
    updateContact(tx, {
      clientId: input.clientId,
      id: input.id,
      displayName: input.displayName,
      firstName: input.firstName,
      lastName: input.lastName,
      attrs: input.attrs,
    }),
  );
}

export async function getContactService(
  tenantDb: TenantDb,
  clientId: string,
  id: string,
): Promise<ContactRow | undefined> {
  return tenantDb.withTenant(clientId, (tx) => loadContact(tx, clientId, id));
}

export async function listContactsService(
  tenantDb: TenantDb,
  input: ListContactsRepoInput,
): Promise<ListContactsRepoResult> {
  return listContacts(tenantDb, input);
}

export interface SetContactTagsServiceInput {
  clientId: string;
  contactId: string;
  add?: string[];
  remove?: string[];
}

/** Applies the add/remove tag links, then re-loads the full contact item (so the route can return the whole updated resource). */
export async function setContactTagsService(
  tenantDb: TenantDb,
  input: SetContactTagsServiceInput,
): Promise<{ contact: ContactRow; tags: ContactTagRefRow[] } | undefined> {
  return tenantDb.withTenant(input.clientId, async (tx) => {
    const tagsByContact = await setContactTags(tx, {
      clientId: input.clientId,
      contactId: input.contactId,
      add: input.add,
      remove: input.remove,
    });
    const contact = await loadContact(tx, input.clientId, input.contactId);
    if (!contact) return undefined;
    return { contact, tags: tagsByContact.get(input.contactId) ?? [] };
  });
}
