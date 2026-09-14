// Fixture: packages/server-kit/src must never import Baileys directly - the
// engine is injected behind a codec/port (P01 step 9). This file deliberately
// violates server-kit-src-never-imports-baileys via the SCOPED fork package
// name (`@whiskeysockets/baileys`), not just the bare `baileys` specifier -
// proving the rule's alternation catches both forms.
import makeWASocket from '@whiskeysockets/baileys';

export const socket = makeWASocket;
