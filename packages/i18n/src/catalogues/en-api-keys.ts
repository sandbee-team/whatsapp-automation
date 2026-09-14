import type { Catalogue } from './catalogue-type.js';

/**
 * English strings for the go-live U5 tenant API keys settings screen
 * (`settings.api-keys.tsx`, `features/api-keys/**`); split out of `en.ts` to
 * stay under the 300-line file cap (same idiom as `en-data-ui.ts`).
 * `hi-api-keys.ts` mirrors every key.
 */
export const enApiKeys = {
  'apiKeys.title': 'API keys',
  'apiKeys.subtitle':
    'Use an API key to call the messaging API from your own code. Each request must also carry an Idempotency-Key header.',
  'apiKeys.empty.title': 'No API keys yet',
  'apiKeys.empty.body': 'Create a key to call the messaging API from your own code.',
  'apiKeys.addButton': 'Create key',
  'apiKeys.loading': 'Loading…',
  'apiKeys.error': 'Something went wrong. Please try again.',
  'apiKeys.list.activeBadge': 'Active',
  'apiKeys.list.revokedBadge': 'Revoked',
  'apiKeys.list.createdLabel': 'Created',
  'apiKeys.list.lastUsedLabel': 'Last used',
  'apiKeys.list.neverUsed': 'Never',
  'apiKeys.list.revokedAtLabel': 'Revoked',
  'apiKeys.list.revokeButton': 'Revoke',
  'apiKeys.list.revokeConfirmPrompt': 'Revoke this key? This cannot be undone.',
  'apiKeys.list.revokeConfirmButton': 'Confirm revoke',
  'apiKeys.list.revokeCancelButton': 'Cancel',
  'apiKeys.list.revokeError': 'Could not revoke this key. Please try again.',

  'apiKeys.form.title': 'Create an API key',
  'apiKeys.form.nameLabel': 'Key name',
  'apiKeys.form.nameDescription':
    'A label to help you tell your keys apart, such as the app that uses it.',
  'apiKeys.form.namePlaceholder': 'Order confirmation service',
  'apiKeys.form.submitButton': 'Create key',
  'apiKeys.form.genericError': 'Something went wrong. Please try again.',
  'apiKeys.form.nameRequired': 'Enter a name between 1 and 64 characters.',

  'apiKeys.keyOnce.title': 'Save this API key now',
  'apiKeys.keyOnce.body':
    'This key is shown once and will not be shown again. Store it before closing this dialog.',
  'apiKeys.keyOnce.copyButton': 'Copy key',
  'apiKeys.keyOnce.copiedLabel': 'Copied',
  'apiKeys.keyOnce.doneButton': 'Done',
} as const satisfies Catalogue;
