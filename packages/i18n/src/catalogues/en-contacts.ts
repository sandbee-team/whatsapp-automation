/**
 * en-contacts.ts (P20 Unit U9, step 10) - the `contacts.*`/`nav.contacts`
 * English keys, split out of `en.ts` (that file sat near the `max-lines: 300`
 * cap - core-invariants.md's mandatory split idiom, sibling module rather
 * than trimming a contract/behaviour comment). Spread into `en.ts`'s default
 * export; `hi-contacts.ts` is the matching Hindi sibling.
 *
 * Byte-identical copy of `@wp/domain`'s `CONTACTS_COPY.attestationNotice` -
 * `@wp/i18n` carries zero dependencies so this cannot be a re-export;
 * `features/contacts/copy.test.ts` proves the drift guard. The other
 * `CONTACTS_COPY` strings (invalid-rows/opted-out/export/erasure notes) are
 * rendered directly from `@wp/domain` by the components, not through `t()`,
 * so they carry no catalogue-key literal here.
 */
const CONTACTS_ATTESTATION_NOTICE_LITERAL =
  'We record who asserted consent; we do not and cannot verify it.';

export const enContacts = {
  'nav.contacts': 'Contacts',

  'contacts.title': 'Contacts',
  'contacts.subtitle': 'Your address book of contacts and their opt-out state.',
  'contacts.searchLabel': 'Search contacts',
  'contacts.searchPlaceholder': 'Search by name or phone number',
  'contacts.filter.optOutAll': 'All contacts',
  'contacts.filter.optOutOptedOut': 'Opted out',
  'contacts.filter.optOutNotOptedOut': 'Not opted out',
  'contacts.table.name': 'Name',
  'contacts.table.phone': 'Phone number',
  'contacts.table.tags': 'Tags',
  'contacts.table.status': 'Status',
  'contacts.table.updatedAt': 'Last updated',
  'contacts.table.optedOutBadge': 'Opted out',
  'contacts.loadMore': 'Load more',
  'contacts.loading': 'Loading…',
  'contacts.error': 'Something went wrong. Please try again.',
  'contacts.empty.title': 'No contacts yet',
  'contacts.empty.body': 'Add a contact or import a CSV list to build your address book.',
  'contacts.addButton': 'Add contact',
  'contacts.importButton': 'Import CSV',
  'contacts.exportButton': 'Export CSV',
  'contacts.mfaRequired': 'Re-authenticate with your authenticator code to continue.',

  'contacts.export.confirmTitle': 'Export contacts',
  'contacts.export.confirmButton': 'Download CSV',
  'contacts.export.cancelButton': 'Cancel',

  'contacts.form.title': 'Add a contact',
  'contacts.form.phoneLabel': 'Phone number',
  'contacts.form.phoneDescription': 'Include the country code, e.g. +91XXXXXXXXXX.',
  'contacts.form.countryLabel': 'Default country',
  'contacts.form.nameLabel': 'Name',
  'contacts.form.submitButton': 'Add contact',
  'contacts.form.genericError': 'Something went wrong. Please try again.',

  'contacts.drawer.title': 'Contact details',
  'contacts.drawer.phoneLabel': 'Phone number',
  'contacts.drawer.nameLabel': 'Name',
  'contacts.drawer.saveButton': 'Save changes',
  'contacts.drawer.savedMessage': 'Changes saved.',
  'contacts.drawer.attrsTitle': 'Attributes',
  'contacts.drawer.attrsEmpty': 'No attributes recorded.',
  'contacts.drawer.tagsTitle': 'Tags',
  'contacts.drawer.addTagPlaceholder': 'New tag name',
  'contacts.drawer.addTagButton': 'Create tag',
  'contacts.drawer.removeTagButton': 'Remove',
  'contacts.drawer.optOutTitle': 'Messaging status',
  'contacts.drawer.optedOutSince': 'Opted out since {date}',
  'contacts.drawer.notOptedOut': 'Not opted out',
  'contacts.drawer.eraseButton': 'Erase contact',
  'contacts.drawer.eraseConfirmButton': 'Confirm erase',
  'contacts.drawer.eraseCancelButton': 'Cancel',
  'contacts.drawer.eraseError': 'Could not erase this contact. Please try again.',

  'contacts.import.title': 'Import contacts',
  'contacts.import.step.upload': 'Upload',
  'contacts.import.step.mapping': 'Mapping',
  'contacts.import.step.attestation': 'Attestation',
  'contacts.import.step.progress': 'Progress',
  'contacts.import.step.result': 'Result',
  'contacts.import.upload.label': 'CSV file',
  'contacts.import.upload.description': 'A CSV file up to 16 MB.',
  'contacts.import.upload.button': 'Upload',
  'contacts.import.tooLarge': 'This file is larger than 16 MB. Please split it into smaller files.',
  'contacts.import.notCsv': 'Please choose a .csv file.',
  'contacts.import.uploadError': 'Something went wrong uploading this file. Please try again.',
  'contacts.import.mapping.phoneLabel': 'Phone number column',
  'contacts.import.mapping.nameLabel': 'Name column (optional)',
  'contacts.import.mapping.attrKeyLabel': 'Attribute key',
  'contacts.import.mapping.attrColumnLabel': 'Column',
  'contacts.import.mapping.addAttrButton': 'Add attribute mapping',
  'contacts.import.mapping.countryLabel': 'Default country',
  'contacts.import.mapping.tagsLabel': 'Apply tags to imported contacts',
  'contacts.import.mapping.previewTitle': 'Preview (first 10 rows)',
  'contacts.import.mapping.continueButton': 'Continue',
  'contacts.import.attestationNotice': CONTACTS_ATTESTATION_NOTICE_LITERAL,
  // No separate Hindi rendering in the `en` catalogue - the wizard only
  // renders `attestationNoticeHi` below the verbatim English sentence when
  // the active locale is `hi` (see `hi-contacts.ts`'s own doc comment); kept
  // here only so both catalogues carry the same key set (`copy.test.ts`'s
  // parity assertion).
  'contacts.import.attestationNoticeHi': '',
  'contacts.import.attestationCheckbox':
    'I confirm the people on this list agreed to receive messages from us.',
  'contacts.import.attestationSourceLabel': 'Where did this list come from?',
  'contacts.import.startButton': 'Start import',
  'contacts.import.progress.title': 'Importing your contacts',
  'contacts.import.progress.rowsProcessed': '{cursorRow} rows processed',
  'contacts.import.progress.rowsProcessedOfTotal': '{cursorRow} / {totalRows} rows processed',
  'contacts.import.progress.cancelButton': 'Cancel import',
  'contacts.import.result.title': 'Import finished',
  'contacts.import.result.imported': 'Imported',
  'contacts.import.result.updated': 'Updated',
  'contacts.import.result.duplicates': 'Duplicates',
  'contacts.import.result.invalid': 'Invalid',
  'contacts.import.result.optedOutPreserved': 'Opted-out preserved',
  'contacts.import.downloadErrorsButton': 'Download error CSV',
  'contacts.import.error.max_contacts_exceeded':
    'This import would exceed your plan’s contact limit. Remove some contacts or contact support to raise the limit.',
  'contacts.import.error.generic': 'The import could not finish. Please try again.',
  'contacts.import.closeButton': 'Close',

  'contacts.tags.filterLabel': 'Filter by tag',
} as const;
