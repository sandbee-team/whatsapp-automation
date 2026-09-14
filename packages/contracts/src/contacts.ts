import { oc } from '@orpc/contract';
import { z } from 'zod';
import { successEnvelope, paginationInputSchema } from './envelope.js';

/**
 * contacts.ts (P20 Unit U4, step 4) - the tenant contacts + tags surface.
 * `.strict()` on every object schema so an unplanned field cannot silently
 * drift the wire shape (same discipline as `app/wallet.ts`/`app/webhooks.ts`).
 * `phone` is the ONLY identity a caller supplies on create - it is normalised
 * server-side (`@wp/domain`'s `normaliseE164`) and never updatable
 * afterwards (`updateContactInputSchema` carries no `phone` field).
 *
 * `attrs` is a small, bounded free-form bag: `contactAttrsSchema` caps keys
 * at 20 (`.refine`) and each key to `^[a-z][a-z0-9_]{0,31}$`; the 2,048-byte
 * total-size cap is enforced by the DB CHECK constraint
 * (`contacts_attrs_max_2048`, migration 0060) and surfaced as a
 * `VALIDATION_ERROR` from the route layer, never re-checked here (one
 * authority, never a driftable duplicate).
 */

export const contactSourceSchema = z.enum(['import', 'inbound', 'manual', 'api']);
export type ContactSourceContract = z.infer<typeof contactSourceSchema>;

export const contactOptOutStateSchema = z.enum(['none', 'opted_out']);
export type ContactOptOutStateContract = z.infer<typeof contactOptOutStateSchema>;

export const consentBasisSchema = z.enum([
  'user_declared_optin',
  'imported_with_attestation',
  'inbound_initiated',
]);
export type ConsentBasisContract = z.infer<typeof consentBasisSchema>;

export const addressingModeSchema = z.enum(['pn', 'lid']);
export type AddressingModeContract = z.infer<typeof addressingModeSchema>;

export const contactTagRefSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    color: z.string().nullable(),
  })
  .strict();
export type ContactTagRef = z.infer<typeof contactTagRefSchema>;

export const contactItemSchema = z
  .object({
    id: z.string().uuid(),
    phoneE164: z.string(),
    waJid: z.string(),
    addressingMode: addressingModeSchema,
    displayName: z.string().nullable(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    attrs: z.record(z.string(), z.unknown()),
    source: contactSourceSchema,
    consentBasis: consentBasisSchema.nullable(),
    optOutState: contactOptOutStateSchema,
    optedOutAt: z.string().nullable(),
    lastInboundAt: z.string().nullable(),
    lastOutboundAt: z.string().nullable(),
    tags: z.array(contactTagRefSchema),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type ContactItem = z.infer<typeof contactItemSchema>;

/** Free-form attrs bag: at most 20 keys, each `^[a-z][a-z0-9_]{0,31}$`, values a string/number/boolean/null. */
export const contactAttrsSchema = z
  .record(
    z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
    z.union([z.string().max(500), z.number(), z.boolean(), z.null()]),
  )
  .refine((attrs) => Object.keys(attrs).length <= 20, {
    message: 'attrs may carry at most 20 keys',
  });
export type ContactAttrsInput = z.infer<typeof contactAttrsSchema>;

export const createContactInputSchema = z
  .object({
    phone: z.string().trim().min(1).max(64),
    defaultCountry: z
      .string()
      .regex(/^[A-Za-z]{2}$/)
      .optional(),
    displayName: z.string().trim().min(1).max(200).optional(),
    firstName: z.string().trim().min(1).max(200).optional(),
    lastName: z.string().trim().min(1).max(200).optional(),
    attrs: contactAttrsSchema.optional(),
    // `imported_with_attestation` is import-only (contact_imports's own
    // attestation flow) and is deliberately absent from this enum - never
    // creatable through this route.
    consentBasis: z.enum(['user_declared_optin', 'inbound_initiated']).optional(),
    tagIds: z.array(z.string().uuid()).max(50).optional(),
  })
  .strict();
export type CreateContactInput = z.infer<typeof createContactInputSchema>;

export const createContactOutputSchema = successEnvelope(contactItemSchema);
export type CreateContactOutput = z.infer<typeof createContactOutputSchema>;

export const createContactContract = oc
  .route({ method: 'POST', path: '/v1/contacts' })
  .input(createContactInputSchema)
  .output(createContactOutputSchema);

/** Every field optional and independently provided/omitted - phone is identity and is never updatable here. */
export const updateContactInputSchema = z
  .object({
    displayName: z.string().trim().max(200).nullable().optional(),
    firstName: z.string().trim().max(200).nullable().optional(),
    lastName: z.string().trim().max(200).nullable().optional(),
    attrs: contactAttrsSchema.optional(),
  })
  .strict();
export type UpdateContactInput = z.infer<typeof updateContactInputSchema>;

export const updateContactOutputSchema = successEnvelope(contactItemSchema);
export type UpdateContactOutput = z.infer<typeof updateContactOutputSchema>;

export const updateContactContract = oc
  .route({ method: 'PATCH', path: '/v1/contacts/{id}' })
  .input(updateContactInputSchema)
  .output(updateContactOutputSchema);

export const getContactInputSchema = z.object({ id: z.string().uuid() }).strict();
export type GetContactInput = z.infer<typeof getContactInputSchema>;

export const getContactOutputSchema = successEnvelope(contactItemSchema);
export type GetContactOutput = z.infer<typeof getContactOutputSchema>;

export const getContactContract = oc
  .route({ method: 'GET', path: '/v1/contacts/{id}' })
  .input(getContactInputSchema)
  .output(getContactOutputSchema);

export const listContactsInputSchema = paginationInputSchema.extend({
  q: z.string().trim().min(1).max(100).optional(),
  tagId: z.string().uuid().optional(),
  optOutState: contactOptOutStateSchema.optional(),
});
export type ListContactsInput = z.infer<typeof listContactsInputSchema>;

export const listContactsOutputSchema = successEnvelope(
  z.object({ items: z.array(contactItemSchema) }).strict(),
);
export type ListContactsOutput = z.infer<typeof listContactsOutputSchema>;

export const listContactsContract = oc
  .route({ method: 'GET', path: '/v1/contacts' })
  .input(listContactsInputSchema)
  .output(listContactsOutputSchema);

export const setContactTagsInputSchema = z
  .object({
    add: z.array(z.string().uuid()).max(50).optional(),
    remove: z.array(z.string().uuid()).max(50).optional(),
  })
  .strict();
export type SetContactTagsInput = z.infer<typeof setContactTagsInputSchema>;

export const setContactTagsOutputSchema = successEnvelope(contactItemSchema);
export type SetContactTagsOutput = z.infer<typeof setContactTagsOutputSchema>;

export const setContactTagsContract = oc
  .route({ method: 'POST', path: '/v1/contacts/{id}/tags' })
  .input(setContactTagsInputSchema)
  .output(setContactTagsOutputSchema);

// ---------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------

export const contactTagItemSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    color: z.string().nullable(),
    contactCount: z.number().int().nonnegative(),
    createdAt: z.string(),
  })
  .strict();
export type ContactTagItem = z.infer<typeof contactTagItemSchema>;

export const createContactTagInputSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
  })
  .strict();
export type CreateContactTagInput = z.infer<typeof createContactTagInputSchema>;

export const createContactTagOutputSchema = successEnvelope(contactTagItemSchema);
export type CreateContactTagOutput = z.infer<typeof createContactTagOutputSchema>;

export const createContactTagContract = oc
  .route({ method: 'POST', path: '/v1/contacts/tags' })
  .input(createContactTagInputSchema)
  .output(createContactTagOutputSchema);

export const listContactTagsOutputSchema = successEnvelope(
  z.object({ items: z.array(contactTagItemSchema) }).strict(),
);
export type ListContactTagsOutput = z.infer<typeof listContactTagsOutputSchema>;

export const listContactTagsContract = oc
  .route({ method: 'GET', path: '/v1/contacts/tags' })
  .output(listContactTagsOutputSchema);

export const patchContactTagInputSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .nullable()
      .optional(),
  })
  .strict();
export type PatchContactTagInput = z.infer<typeof patchContactTagInputSchema>;

export const patchContactTagOutputSchema = successEnvelope(contactTagItemSchema);
export type PatchContactTagOutput = z.infer<typeof patchContactTagOutputSchema>;

export const patchContactTagContract = oc
  .route({ method: 'PATCH', path: '/v1/contacts/tags/{id}' })
  .input(patchContactTagInputSchema)
  .output(patchContactTagOutputSchema);

export const deleteContactTagInputSchema = z.object({ id: z.string().uuid() }).strict();
export type DeleteContactTagInput = z.infer<typeof deleteContactTagInputSchema>;

export const deleteContactTagOutputSchema = successEnvelope(
  z.object({ id: z.string().uuid() }).strict(),
);
export type DeleteContactTagOutput = z.infer<typeof deleteContactTagOutputSchema>;

export const deleteContactTagContract = oc
  .route({ method: 'DELETE', path: '/v1/contacts/tags/{id}' })
  .output(deleteContactTagOutputSchema);

export const contactsContract = {
  list: listContactsContract,
  get: getContactContract,
  create: createContactContract,
  update: updateContactContract,
  setTags: setContactTagsContract,
  tags: {
    list: listContactTagsContract,
    create: createContactTagContract,
    patch: patchContactTagContract,
    delete: deleteContactTagContract,
  },
} as const;
