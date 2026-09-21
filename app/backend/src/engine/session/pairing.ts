/**
 * pairing.ts (P08 U5a) - bounded QR/pairing-code pairing: 5 attempts / 5-
 * minute window, terminal `pairing_expired` with NO auto-loop and NO retry
 * timer of its own. `onQr` and `startCodePairing` share ONE accounting path
 * (`incrementQrAttempts`) - a code-pairing attempt consumes the SAME budget
 * as a QR attempt, never a separate counter. The attempt budget itself comes
 * from `@wp/domain`'s `PAIRING_MAX_ATTEMPTS` (single source of truth shared
 * with `instances.routes.ts`'s attemptsLeft computation, P08 FIX BATCH A A8).
 *
 * `qrTtlMs` (2026-09-17 90s UX fix): this is a DISPLAY countdown only - it
 * never gates when `handleAttempt` runs. `handleAttempt` fires once per
 * `update.qr` event Baileys itself emits (runner-connection-update.ts's
 * `onQr` call), and Baileys regenerates its QR on ITS OWN internal
 * `qrTimeout` (provider/baileys/socket-factory.ts, pinned at a fixed
 * `45_000` independent of this file), not on this value. So raising
 * `qrTtlMs` to 90_000 does NOT slow down attempt consumption - attempts
 * still arrive roughly every ~45s regardless of what this constant is set
 * to - it only raises how much time the countdown ring/panel PROMISES the
 * operator before showing "expired". The two are decoupled by construction:
 * a fresh `instance.qr` publish (this file's `publish` call below) replaces
 * whatever the panel was showing, on every Baileys refresh, so a still-live
 * QR is never left stranded behind a stale 90s countdown - the browser
 * just sees the payload/expiresAt jump forward whenever Baileys hands us a
 * new one (`useLinkStream.ts`'s `setState` on every `instance.qr` event).
 * `windowMs` (below) does NOT need to change for this reason: since attempt
 * spacing is Baileys' ~45s cadence, not `qrTtlMs`, 5 attempts still land at
 * roughly t=0/45s/90s/135s/180s - comfortably inside the existing 300_000ms
 * (5 min) window either way. (A prior version of this comment assumed
 * `qrTtlMs` itself paced attempts, which would have made 5 attempts at 90s
 * apart exceed a 300s window - traced against `runner-connection-update.ts`
 * and found that assumption false: `onQr` is driven by Baileys' `qr` event,
 * never by this file's own timer.)
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
  // 90s (2026-09-17, operator-requested): 45s left no time to pick up the
  // phone, open WhatsApp, and navigate to Settings -> Linked Devices -> Link
  // a device before the panel showed "expired" - see this file's own module
  // doc comment for why raising this does not require raising `windowMs`.
  const qrTtlMs = deps.qrTtlMs ?? 90_000;

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
