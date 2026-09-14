// Fixture (P20 Unit U3, pacing-never-imports-contacts): imports the
// contacts barrel (index.ts), so only pacing-never-imports-contacts fires,
// never no-deep-module-import (which only catches reaching PAST a
// sibling's index.ts).
import { contactsStub } from '../../contacts/index.js';

export function readMirror(): unknown {
  return contactsStub;
}
