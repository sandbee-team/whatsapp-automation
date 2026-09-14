import type { z } from 'zod';
import {
  contactItemSchema,
  createContactInputSchema,
  updateContactInputSchema,
  setContactTagsInputSchema,
  contactTagItemSchema,
  createContactTagInputSchema,
  patchContactTagInputSchema,
  createContactImportInputSchema,
  contactImportItemSchema,
  uploadImportOutputSchema,
} from '@wp/contracts';
import { apiFetch, apiFetchRaw, ApiError } from '../../lib/api-client.js';
import type { ContactsListFilters } from './keys.js';

/**
 * features/contacts/api.ts (P20 Unit U9, step 10) - the client side of the
 * contacts + tags + import surface. Every response type is inferred FROM the
 * imported `@wp/contracts` schemas (never hand-typed), same idiom as
 * `features/webhooks/api.ts`/`features/wallet/api.ts`.
 */
export type ContactItem = z.infer<typeof contactItemSchema>;
export type CreateContactInput = z.infer<typeof createContactInputSchema>;
export type UpdateContactInput = z.infer<typeof updateContactInputSchema>;
export type SetContactTagsInput = z.infer<typeof setContactTagsInputSchema>;
export type ContactTagItem = z.infer<typeof contactTagItemSchema>;
export type CreateContactTagInput = z.infer<typeof createContactTagInputSchema>;
export type PatchContactTagInput = z.infer<typeof patchContactTagInputSchema>;
export type CreateContactImportInput = z.infer<typeof createContactImportInputSchema>;
export type ContactImportItem = z.infer<typeof contactImportItemSchema>;
export type UploadImportResult = z.infer<typeof uploadImportOutputSchema>['data'];

export interface ContactsListPage {
  items: ContactItem[];
  nextCursor?: string;
}

/**
 * `GET /v1/contacts` - `apiFetch` only ever returns `data`, so the keyset
 * `nextCursor` (carried on `meta`) is read here via a small envelope fetch
 * kept local to this function - no shared `apiFetchEnvelope` helper is
 * needed elsewhere in this feature.
 */
export async function listContacts(
  filters: ContactsListFilters,
  cursor: string | undefined,
): Promise<ContactsListPage> {
  const params = new URLSearchParams();
  if (filters.q) params.set('q', filters.q);
  if (filters.tagId) params.set('tagId', filters.tagId);
  if (filters.optOutState) params.set('optOutState', filters.optOutState);
  if (cursor) params.set('cursor', cursor);
  const query = params.toString();

  const response = await apiFetchRaw(`/v1/contacts${query ? `?${query}` : ''}`, {
    accept: 'application/json',
  });
  const json = (await response.json()) as {
    data: { items: ContactItem[] };
    meta: { nextCursor?: string };
  };
  return { items: json.data.items, nextCursor: json.meta.nextCursor };
}

export function getContact(id: string): Promise<ContactItem> {
  return apiFetch<ContactItem>(`/v1/contacts/${id}`);
}

export function createContact(input: CreateContactInput): Promise<ContactItem> {
  return apiFetch<ContactItem>('/v1/contacts', {
    method: 'POST',
    body: createContactInputSchema.parse(input),
  });
}

export function updateContact(id: string, input: UpdateContactInput): Promise<ContactItem> {
  return apiFetch<ContactItem>(`/v1/contacts/${id}`, {
    method: 'PATCH',
    body: updateContactInputSchema.parse(input),
  });
}

export function setContactTags(id: string, input: SetContactTagsInput): Promise<ContactItem> {
  return apiFetch<ContactItem>(`/v1/contacts/${id}/tags`, {
    method: 'POST',
    body: setContactTagsInputSchema.parse(input),
  });
}

/** Erasure - the caller must have already collected the two-step confirm; see `ContactDrawer`. */
export function eraseContact(id: string): Promise<{ id: string; erasedAt: string }> {
  return apiFetch<{ id: string; erasedAt: string }>(`/v1/contacts/${id}`, {
    method: 'DELETE',
  });
}

export function listContactTags(): Promise<ContactTagItem[]> {
  return apiFetch<{ items: ContactTagItem[] }>('/v1/contacts/tags').then((result) => result.items);
}

export function createContactTag(input: CreateContactTagInput): Promise<ContactTagItem> {
  return apiFetch<ContactTagItem>('/v1/contacts/tags', {
    method: 'POST',
    body: createContactTagInputSchema.parse(input),
  });
}

export function patchContactTag(id: string, input: PatchContactTagInput): Promise<ContactTagItem> {
  return apiFetch<ContactTagItem>(`/v1/contacts/tags/${id}`, {
    method: 'PATCH',
    body: patchContactTagInputSchema.parse(input),
  });
}

export function deleteContactTag(id: string): Promise<{ id: string }> {
  return apiFetch<{ id: string }>(`/v1/contacts/tags/${id}`, { method: 'DELETE' });
}

/**
 * `POST /v1/contacts/imports/uploads` - raw CSV body, `Content-Type:
 * text/csv`. `ApiError` surfaces 413 `PAYLOAD_TOO_LARGE` / 415
 * `UNSUPPORTED_MEDIA_TYPE`, though the wizard rejects both cases client-side
 * before ever calling this (see `ImportWizard`'s upload step).
 */
export async function uploadContactImportFile(file: File): Promise<UploadImportResult> {
  const response = await apiFetchRaw('/v1/contacts/imports/uploads', {
    method: 'POST',
    body: file,
    contentType: 'text/csv',
    accept: 'application/json',
  });
  const json = (await response.json()) as { data: UploadImportResult };
  return json.data;
}

export function createContactImport(input: CreateContactImportInput): Promise<ContactImportItem> {
  return apiFetch<ContactImportItem>('/v1/contacts/imports', {
    method: 'POST',
    body: createContactImportInputSchema.parse(input),
  });
}

export function getContactImport(id: string): Promise<ContactImportItem> {
  return apiFetch<ContactImportItem>(`/v1/contacts/imports/${id}`);
}

export function cancelContactImport(id: string): Promise<ContactImportItem> {
  return apiFetch<ContactImportItem>(`/v1/contacts/imports/${id}/cancel`, { method: 'POST' });
}

/** Downloads the authorised, tenant-scoped error CSV for one import - never a public URL. */
export async function downloadImportErrorsCsv(id: string): Promise<Blob> {
  const response = await apiFetchRaw(`/v1/contacts/imports/${id}/errors.csv`, {
    accept: 'text/csv',
  });
  return response.blob();
}

/** Downloads the authorised contact export - `session_mfa`; a 401 `MFA_REQUIRED` bubbles as `ApiError`. */
export async function downloadContactsExportCsv(): Promise<Blob> {
  const response = await apiFetchRaw('/v1/contacts/export.csv', { accept: 'text/csv' });
  return response.blob();
}

export { ApiError };
