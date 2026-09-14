/**
 * @wp/server-kit/crypto - envelope AES-256-GCM (DEK per record, KEK per
 * purpose, split AAD), rewrapDek() for KEK rotation, the KeyProvider /
 * FileKeyProvider key ring, and the sealJson/openJson codec-injected JSON
 * boundary.
 *
 * Filled so far (P01 step 7 - the key ring; step 8 - the envelope; step 9 -
 * rotation and the JSON boundary): purposes, the `KeyProvider` interface,
 * `FileKeyProvider`, the split-AAD formulas (`dekWrapAad`/`recordAad`), the
 * `SealedBlob` shape, `seal`/`open`, `rewrapDek`, and `sealJson`/`openJson`.
 */
export { KEK_PURPOSES, type KekPurpose } from './purposes.js';
export { type KekEntry, type KeyProvider, makeKekEntry } from './key-provider.js';
export { FileKeyProvider, type FileKeyProviderOptions } from './file-key-provider.js';
export { keyRingSchema, type KeyRing } from './key-ring-schema.js';
export { dekWrapAad, recordAad, type DekWrapAadParams, type RecordAadParams } from './aad.js';
export type { SealedBlob } from './sealed-blob.js';
export { seal, open, type SealParams, type OpenParams } from './envelope.js';
export { rewrapDek, type RewrapDekOptions } from './rotate.js';
export { sealJson, openJson, type JsonCodec } from './json-codec.js';
