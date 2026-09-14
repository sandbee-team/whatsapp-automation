/**
 * contacts.ts (P20 Unit U9, step 10) - verbatim user-facing contacts/import
 * copy (phase file's Copy section, design §2.3 step 2). No caller may
 * hand-roll the attestation sentence or the import result notes; every one
 * is imported from here, same idiom as `pacing-copy.ts`.
 *
 * Every string states facts, never a verification/validation claim (core
 * invariant 6, this phase's own "refusal made mechanical" bullet: no bulk
 * provider-side number lookup exists and this copy never implies one does).
 */
export const CONTACTS_COPY = Object.freeze({
  /**
   * Verbatim from the phase file and design §2.3 step 2 - rendered on the
   * attestation step in EVERY locale, never translated away.
   */
  attestationNotice: 'We record who asserted consent; we do not and cannot verify it.',
  /**
   * Result screen - honest: nothing here is "verified"/"WhatsApp-checked";
   * invalid rows were simply not importable.
   */
  invalidRowsNote:
    'Rows without a usable phone number were not imported. Numbers are not checked against ' +
    'WhatsApp; an unreachable recipient shows up only when a message to them fails.',
  optedOutPreservedNote:
    'Contacts who had already opted out stay opted out. Importing a list never re-enables ' +
    'messaging to someone who asked you to stop.',
  exportNote:
    'This export contains personal data of your contacts. Handle it under your own privacy obligations.',
  erasureNote:
    'Erasing removes the name and attributes and hides the contact. If this person opted out, ' +
    'that record is kept so they are never messaged again.',
} as const);

export type ContactsCopy = typeof CONTACTS_COPY;
