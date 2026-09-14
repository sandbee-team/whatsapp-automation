import { adminMutate } from '../../lib/api-client.js';
import type { MutationResult } from '../clients/api.js';

/**
 * features/wallet/api.ts (P28 Unit U6, step 9) - the client-scoped wallet
 * mutations (`credit`/`adjust`/`freeze`/`unfreeze`). Amounts always cross the
 * wire as decimal PAISE strings, never a JS number (core convention: no
 * `parseFloat`/`Number()` on money) - callers already hold a validated
 * digits-only string from the form.
 */
export type WalletCreditKind = 'topup_manual' | 'promo_credit' | 'adjustment_credit';

export function creditWallet(
  clientId: string,
  amountMinor: string,
  kind: WalletCreditKind,
  reason: string,
  idempotencyKey: string,
): Promise<MutationResult> {
  return adminMutate(
    `/admin/v1/clients/${clientId}/wallet/credit`,
    { reason, amountMinor, kind },
    { idempotencyKey },
  );
}

export function adjustWallet(
  clientId: string,
  amountMinor: string,
  reason: string,
  idempotencyKey: string,
): Promise<MutationResult> {
  return adminMutate(
    `/admin/v1/clients/${clientId}/wallet/adjust`,
    { reason, amountMinor },
    { idempotencyKey },
  );
}

export function freezeWallet(
  clientId: string,
  reason: string,
  idempotencyKey: string,
): Promise<MutationResult> {
  return adminMutate(`/admin/v1/clients/${clientId}/wallet/freeze`, { reason }, { idempotencyKey });
}

export function unfreezeWallet(
  clientId: string,
  reason: string,
  idempotencyKey: string,
): Promise<MutationResult> {
  return adminMutate(
    `/admin/v1/clients/${clientId}/wallet/unfreeze`,
    { reason },
    { idempotencyKey },
  );
}
