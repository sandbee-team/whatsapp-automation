// Fixture: packages/server-kit/src must never import Baileys directly - the
// engine is injected behind a codec/port (P01 step 9). This file
// deliberately violates server-kit-src-never-imports-baileys.
import makeWASocket from 'baileys';

export const socket = makeWASocket;
