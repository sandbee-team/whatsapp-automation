/**
 * index.ts (P20 Unit U4, step 4) - the contacts module's public barrel.
 * `roles/api.ts` and every route composition point import ONLY from here.
 */

export { registerContactsRoutes, type ContactsRoutesDeps, ContactNotFoundError } from './routes.js';
export { registerContactTagsRoutes, ContactTagNotFoundError } from './tags.routes.js';

export {
  ContactLimitReachedError,
  resolveEffectiveMaxContacts,
  countLiveContacts,
  ContactValidationError,
  ContactDuplicatePhoneError,
  InvalidCursorError,
  createContact,
  updateContact,
  loadContact,
  listContacts,
  type ContactRow,
  type CreateContactRepoInput,
  type UpdateContactRepoInput,
  type ListContactsRepoInput,
  type ListContactsRepoResult,
} from './contacts.repo.js';

export {
  createContactService,
  updateContactService,
  getContactService,
  listContactsService,
  setContactTagsService,
} from './contacts.service.js';

export {
  TagNotFoundError,
  listContactTags,
  createContactTag,
  patchContactTag,
  deleteContactTag,
  setContactTags,
  type ContactTagRow,
} from './tags.repo.js';

// --- P20 U5 (import pipeline, step 5/6) ---
export {
  createContactImport,
  getContactImport,
  cancelContactImport,
  lastErrorReason,
  listContactImports,
  listImportErrors,
  AttestationRequiredError,
  ImportMappingInvalidError,
  ImportInvalidStateError,
  type ContactImportRow,
  type ContactImportStatus,
} from './import.repo.js';
export {
  sniffCsvHeader,
  validateMapping,
  renderRecord,
  attrsByteLength,
  MAX_UPLOAD_BYTES,
  UPLOAD_CONTENT_TYPE,
  PREVIEW_ROWS,
  type ImportMapping,
} from './import-upload.js';
export { runOneContactImportSweep } from './import-runner.js';

// --- P20 U7 (opt-out mirror, step 8) - the ONLY mirror writer; injected into
// modules/pacing's recordOptOut/restoreOptOut as a port (pacing never imports
// this module - dependency-cruiser rule pacing-never-imports-contacts). ---
export {
  syncOptOutMirror,
  type OptOutMirrorInput,
  type OptOutMirrorSyncResult,
  type OptOutMirrorWriter,
} from './optout-mirror.js';
export {
  runOneMirrorReconcileSweep,
  type MirrorReconcileDeps,
  type MirrorReconcileOutcome,
} from './mirror-reconcile.js';
export {
  runOneImportRetentionPurge,
  type RetentionPurgeDeps,
  type RetentionPurgeOutcome,
} from './retention-purge.js';

// --- P20 U6 exports (export/erasure/import routes) are appended below this line. ---
export { escapeCsvCell, streamContactsCsv, type StreamContactsCsvInput } from './export.js';
export { eraseContact, type EraseContactInput, type EraseContactResult } from './erasure.js';
export {
  registerContactExportErasureRoutes,
  type ExportErasureRoutesDeps,
} from './export-erasure.routes.js';
export {
  registerContactImportRoutes,
  ContactImportNotFoundError,
  type ContactImportRoutesDeps,
} from './import.routes.js';
