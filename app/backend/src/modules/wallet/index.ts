/**
 * modules/wallet - the ONLY public surface of this module (layering rule
 * §3.2: another module imports only this file, never a sibling directly;
 * enforced by dependency-cruiser's no-deep-module-import). P18 Unit U2
 * ships the price book (pricing.ts) and its SQL repo; later units append
 * ledger/debit/refund exports here.
 */
export { UnpricedKeyError, resolveRateMinor, materialiseMaxRate } from './pricing.js';
export type { EffectiveRateRow } from './wallet.repo.js';
export { chargeSend, chargeRepairedSend, resolveAttemptPrice } from './charge.js';
export type {
  ChargeSendInput,
  ChargeResult,
  ChargeRepairedSendInput,
  ChargeRepairedSendDeps,
  ResolvedAttemptPrice,
} from './charge.js';
export { refundSend } from './refund.js';
export type { RefundResult, RefundSendInput, RefundSendDeps } from './refund.js';
export { createWalletRepairedSendSink } from './wallet-sink.js';
export type { WalletRepairedSendSinkDeps } from './wallet-sink.js';
export { runOneWalletRollupSweep } from './rollup.js';
export type { WalletRollupDeps, WalletRollupSweepResult } from './rollup.js';
export { runOneWalletReconcileSweep } from './reconcile.js';
export type { WalletReconcileDeps, WalletReconcileOutcome } from './reconcile.js';
export { createChargerWorker } from './charger.worker.js';
export type {
  ChargeWorkItem,
  ChargerRedis,
  ChargerWorkerDeps,
  ChargerWorker,
  DrainOnceResult,
} from './charger.worker.js';
export { creditWallet, CREDIT_KINDS, InvalidCreditKindError } from './credit.repo.js';
export type { CreditKind, CreditWalletInput, CreditWalletResult } from './credit.repo.js';
export { creditWalletAndNotify, creditWalletInTx } from './credit.service.js';
export type {
  CreditWalletServiceDeps,
  CreditWalletServiceResult,
  CreditWalletInTxDeps,
} from './credit.service.js';
export { publishWakeForClient } from './resume-wake.js';
export type { PublishWakeForClientDeps } from './resume-wake.js';
export { notifyEmpty, notifyLowIfDue, bindStateNotifierMetrics } from './state-notifier.js';
export type { StateNotifierDeps } from './state-notifier.js';
export { createTopupRequest, listTopupRequests, readTopupRequest } from './topups.repo.js';
export type {
  CreateTopupRequestRepoInput,
  ListTopupRequestsRepoInput,
  ListTopupRequestsRepoResult,
  TopupRequestRow,
} from './topups.repo.js';
export { registerTopupsRoutes } from './topups.routes.js';
export type { TopupsRoutesDeps } from './topups.routes.js';
export { registerWalletRoutes } from './wallet.routes.js';
export type { WalletRoutesDeps } from './wallet.routes.js';
export { readQueueStatus } from './queue-status.repo.js';
export type {
  QueueStatusInstanceRow,
  QueueStatusWorkspaceTotals,
  QueueStatusResult,
} from './queue-status.repo.js';
export { registerQueueStatusRoutes } from './queue-status.routes.js';
export type { QueueStatusRoutesDeps } from './queue-status.routes.js';
