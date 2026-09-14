/**
 * pairing.ts (P08 U5a) - bounded QR/pairing-code pairing: 5 attempts / 5-
 * minute window, terminal `pairing_expired` with NO auto-loop and NO retry
 * timer of its own. `onQr` and `startCodePairing` share ONE accounting path
 * (`incrementQrAttempts`) - a code-pairing attempt consumes the SAME budget
 * as a QR attempt, never a separate counter. The attempt budget itself comes
 * from `@wp/domain`'s `PAIRING_MAX_ATTEMPTS` (single source of truth shared
 * with `instances.routes.ts`'s attemptsLeft computation, P08 FIX BATCH A A8).
 */
import { PAIRING_MAX_ATTEMPTS } from '@wp/domain';

export interface PairingClock {
  now(): number;
}

export interface PairingRepoCtx {
  /** U4's `incrementQrAttempts` (or an equivalent fake), scoped to (instanceId, clientId, fence, workerId) by the caller's closure. */
  incrementQrAttempts(): Promise<{ qr_attempts: number; pairing_started_at: string | Date | null }>;
  /** U4's `markPairingExpired` (or an equivalent fake), scoped the same way. */
  markPairingExpired(): Promise<void>;
}

/** The minimal shape `pairing.ts` needs from a runner's `RunnerHandle`-like object. */
export interface PairingSocketHandle {
  sock: {
    end(err?: Error): void;
    requestPairingCode?(phone: string): Promise<string>;
  };
  teardownWithRelease(): Promise<void>;
}

export type QrPublishEvent =
  | {
      type: 'instance.qr';
      clientId: string;
      instanceId: string;
      payload: string;
      expiresAt: string;
      attemptsLeft: number;
    }
  | {
      type: 'instance.health_changed';
      clientId: string;
      instanceId: string;
    };

export interface CreatePairingControllerDeps {
  repoCtx: PairingRepoCtx;
  publish: (event: QrPublishEvent) => void;
  clock: PairingClock;
  clientId: string;
  instanceId: string;
  maxAttempts?: number;
  windowMs?: number;
  qrTtlMs?: number;
}

export interface PairingController {
  /** Returns `'expired'` on the terminal outcome (attempts/window exhausted), `undefined` otherwise. */
  onQr(handle: PairingSocketHandle, qr: string): Promise<'expired' | undefined>;
  /** Resets internal window bookkeeping on a successful open - a later re-link starts a fresh window. */
  onOpen(handle: PairingSocketHandle): void;
  /** The 8-char pairing-code path - shares `onQr`'s accounting via the SAME `handleAttempt`. */
  startCodePairing(handle: PairingSocketHandle, phone: string): Promise<'expired' | undefined>;
}

/** `null` means EXPIRED (returns `-Infinity` so `clock.now() - (-Infinity) > windowMs` is always true) - never fail-open on this bounded guard, which NaN comparisons used to produce (`NaN > windowMs` is always `false`). Do NOT flip the sign to `+Infinity`: that would make `clock.now() - Infinity` always negative, restoring the fail-open bug. */
function pairingStartedAtMs(pairingStartedAt: string | Date | null): number {
  if (pairingStartedAt === null) {
    return Number.NEGATIVE_INFINITY;
  }
  return new Date(pairingStartedAt).getTime();
}

export function createPairingController(deps: CreatePairingControllerDeps): PairingController {
  const { repoCtx, publish, clock, clientId, instanceId } = deps;
  const maxAttempts = deps.maxAttempts ?? PAIRING_MAX_ATTEMPTS;
  const windowMs = deps.windowMs ?? 300_000;
  const qrTtlMs = deps.qrTtlMs ?? 45_000;

  /** The one accounting path both `onQr` and `startCodePairing` funnel through. */
  async function handleAttempt(
    handle: PairingSocketHandle,
    payload: string,
  ): Promise<'expired' | undefined> {
    const { qr_attempts: qrAttempts, pairing_started_at: pairingStartedAt } =
      await repoCtx.incrementQrAttempts();

    const startedAtMs = pairingStartedAtMs(pairingStartedAt);
    const windowExpired = clock.now() - startedAtMs > windowMs;

    if (qrAttempts > maxAttempts || windowExpired) {
      handle.sock.end(undefined);
      await repoCtx.markPairingExpired();
      publish({ type: 'instance.health_changed', clientId, instanceId });
      await handle.teardownWithRelease();
      return 'expired';
    }

    publish({
      type: 'instance.qr',
      clientId,
      instanceId,
      payload,
      expiresAt: new Date(clock.now() + qrTtlMs).toISOString(),
      attemptsLeft: maxAttempts - qrAttempts,
    });
    return undefined;
  }

  return {
    onQr(handle: PairingSocketHandle, qr: string): Promise<'expired' | undefined> {
      return handleAttempt(handle, qr);
    },

    onOpen(): void {
      // Window/attempt bookkeeping lives entirely in Postgres
      // (qr_attempts/pairing_started_at, reset by U4's beginPairingIntent on
      // the NEXT pairing intent) - there is no in-memory state to reset
      // here. This hook exists as the documented seam for a future
      // in-process cache, kept a no-op deliberately rather than inventing
      // one now.
    },

    async startCodePairing(
      handle: PairingSocketHandle,
      phone: string,
    ): Promise<'expired' | undefined> {
      const requestPairingCode = handle.sock.requestPairingCode;
      if (!requestPairingCode) {
        throw new Error(
          'startCodePairing: the underlying socket does not support requestPairingCode',
        );
      }
      const code = await requestPairingCode(phone);
      return handleAttempt(handle, code);
    },
  };
}
