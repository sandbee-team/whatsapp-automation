import { oc } from '@orpc/contract';
import { z } from 'zod';
import { successEnvelope, paginationInputSchema } from './envelope.js';

/**
 * contact-imports.ts (P20 Unit U6, step 5/7) - the CSV import upload/create/
 * poll/cancel/errors surface, plus `DELETE /v1/contacts/:id` (erasure) and
 * `GET /v1/contacts/export.csv` which are wire-shaped here too (see this
 * file's own export/erase schemas below) since they are a natural extension
 * of the SAME "contacts import/export" surface U4's `contacts.ts` started.
 * `.strict()` on every object schema, same discipline as `contacts.ts`.
 */

export const contactImportStatusSchema = z.enum([
  'uploaded',
  'validating',
  'importing',
  'done',
  'failed',
  'cancelled',
]);
export type ContactImportStatusContract = z.infer<typeof contactImportStatusSchema>;

export const importMappingSchema = z
  .object({
    phone: z.string().min(1),
    name: z.string().min(1).nullable().optional(),
    attrs: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), z.string().min(1)).optional(),
  })
  .strict();
export type ImportMappingContract = z.infer<typeof importMappingSchema>;

export const uploadImportOutputSchema = successEnvelope(
  z
    .object({
      storageKey: z.string(),
      bytes: z.number().int(),
      columns: z.array(z.string()),
      preview: z.array(z.array(z.string())).max(10),
      delimiter: z.enum([',', ';', '\t']),
      defaultCountry: z.string().length(2),
    })
    .strict(),
);
export type UploadImportOutput = z.infer<typeof uploadImportOutputSchema>;

export const uploadContactImportContract = oc
  .route({ method: 'POST', path: '/v1/contacts/imports/uploads' })
  .output(uploadImportOutputSchema);

/** Path-param schema for every `contact_imports` route keyed by `:id` (m1) - `.strict()` so an unplanned extra param field is rejected too. */
export const contactImportIdParamSchema = z.object({ id: z.string().uuid() }).strict();
export type ContactImportIdParam = z.infer<typeof contactImportIdParamSchema>;

export const createContactImportInputSchema = z
  .object({
    storageKey: z.string().min(1).max(512),
    filename: z.string().trim().max(255).optional(),
    mapping: importMappingSchema,
    defaultCountry: z
      .string()
      .regex(/^[A-Za-z]{2}$/)
      .optional(),
    applyTagIds: z.array(z.string().uuid()).max(20).optional(),
    attestationText: z.string().trim().min(3).max(2000),
    attestationAccepted: z.literal(true),
  })
  .strict();
export type CreateContactImportInputContract = z.infer<typeof createContactImportInputSchema>;

export const contactImportItemSchema = z
  .object({
    id: z.string().uuid(),
    filename: z.string().nullable(),
    status: contactImportStatusSchema,
    defaultCountry: z.string(),
    mapping: importMappingSchema,
    applyTagIds: z.array(z.string().uuid()),
    attestationText: z.string(),
    attestedByUserId: z.string().uuid(),
    attestedAt: z.string(),
    cursorRow: z.number().int(),
    totalRows: z.number().int().nullable(),
    importedCount: z.number().int(),
    updatedCount: z.number().int(),
    invalidCount: z.number().int(),
    duplicateCount: z.number().int(),
    optedOutCount: z.number().int(),
    lastErrorReason: z.string().nullable(),
    createdAt: z.string(),
    finishedAt: z.string().nullable(),
  })
  .strict();
export type ContactImportItem = z.infer<typeof contactImportItemSchema>;

export const createContactImportOutputSchema = successEnvelope(contactImportItemSchema);
export type CreateContactImportOutput = z.infer<typeof createContactImportOutputSchema>;

export const createContactImportContract = oc
  .route({ method: 'POST', path: '/v1/contacts/imports' })
  .input(createContactImportInputSchema)
  .output(createContactImportOutputSchema);

export const listContactImportsInputSchema = paginationInputSchema;
export type ListContactImportsInputContract = z.infer<typeof listContactImportsInputSchema>;

export const listContactImportsOutputSchema = successEnvelope(
  z.object({ items: z.array(contactImportItemSchema) }).strict(),
);
export type ListContactImportsOutput = z.infer<typeof listContactImportsOutputSchema>;

export const listContactImportsContract = oc
  .route({ method: 'GET', path: '/v1/contacts/imports' })
  .input(listContactImportsInputSchema)
  .output(listContactImportsOutputSchema);

export const getContactImportOutputSchema = successEnvelope(contactImportItemSchema);
export type GetContactImportOutput = z.infer<typeof getContactImportOutputSchema>;

export const getContactImportContract = oc
  .route({ method: 'GET', path: '/v1/contacts/imports/{id}' })
  .output(getContactImportOutputSchema);

export const cancelContactImportOutputSchema = successEnvelope(contactImportItemSchema);
export type CancelContactImportOutput = z.infer<typeof cancelContactImportOutputSchema>;

export const cancelContactImportContract = oc
  .route({ method: 'POST', path: '/v1/contacts/imports/{id}/cancel' })
  .output(cancelContactImportOutputSchema);

/** `errors.csv` streams a CSV body, never a JSON envelope - no output schema here (route-level contract only). */
export const contactImportErrorsCsvContract = oc.route({
  method: 'GET',
  path: '/v1/contacts/imports/{id}/errors.csv',
});

export const eraseContactOutputSchema = successEnvelope(
  z.object({ id: z.string().uuid(), erasedAt: z.string() }).strict(),
);
export type EraseContactOutput = z.infer<typeof eraseContactOutputSchema>;

export const eraseContactContract = oc
  .route({ method: 'DELETE', path: '/v1/contacts/{id}' })
  .output(eraseContactOutputSchema);

/** `export.csv` streams a CSV body, never a JSON envelope - no output schema here (route-level contract only). */
export const exportContactsCsvContract = oc.route({
  method: 'GET',
  path: '/v1/contacts/export.csv',
});

export const contactImportsContract = {
  upload: uploadContactImportContract,
  create: createContactImportContract,
  list: listContactImportsContract,
  get: getContactImportContract,
  cancel: cancelContactImportContract,
  errorsCsv: contactImportErrorsCsvContract,
  erase: eraseContactContract,
  exportCsv: exportContactsCsvContract,
} as const;
