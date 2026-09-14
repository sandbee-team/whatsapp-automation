import type {
  BaileysGroupSocketPort,
  BaileysSendSocketPort,
} from '../../provider/baileys/adapter.js';
import type { FakeableSocket, RunnerSessionState } from './runner-types.js';

/**
 * runner-handle.ts (P24 Unit U3, step 4/5) - the three optional
 * `RunnerHandle` accessors (`getSendSocket`, `getGroupSocket`,
 * `inventorySnapshot`), split out of `runner.ts` purely for that file's
 * max-lines cap (same split idiom as `runner-connection-update.ts`/
 * `runner-deferred-open.ts`) - pure code motion, no behaviour change to the
 * P12 U0 `getSendSocket`/inventory logic already there.
 *
 * `getGroupSocket` mirrors `getSendSocket`'s exact fail-closed predicate
 * (connected + linked + live) and returns ONLY
 * `groupFetchAllParticipating`/`groupLeave`/`selfJid` - never the raw
 * socket, never `.logout()`, never any participant-management method (see
 * `BaileysGroupSocketPort`'s own doc comment, `provider/baileys/adapter.ts`).
 */

function isSendCapable(
  sock: FakeableSocket | undefined,
  state: RunnerSessionState,
): sock is FakeableSocket & { sendMessage: NonNullable<FakeableSocket['sendMessage']> } {
  return Boolean(
    sock &&
    !state.ended &&
    state.healthState === 'connected' &&
    state.linkState === 'linked' &&
    typeof sock.sendMessage === 'function',
  );
}

/** P12 U0 (moved verbatim): fails closed unless open+linked, live, sendMessage-capable; returns ONLY `sendMessage` - never the raw socket or `.logout`. */
export function buildGetSendSocket(
  getCurrentSock: () => FakeableSocket | undefined,
  state: RunnerSessionState,
): () => BaileysSendSocketPort | undefined {
  return () => {
    const sock = getCurrentSock();
    if (!isSendCapable(sock, state)) {
      return undefined;
    }
    return { sendMessage: sock.sendMessage.bind(sock) };
  };
}

function isGroupCapable(
  sock: FakeableSocket | undefined,
  state: RunnerSessionState,
): sock is FakeableSocket & {
  groupFetchAllParticipating: NonNullable<FakeableSocket['groupFetchAllParticipating']>;
  groupLeave: NonNullable<FakeableSocket['groupLeave']>;
} {
  return Boolean(
    sock &&
    !state.ended &&
    state.healthState === 'connected' &&
    state.linkState === 'linked' &&
    typeof sock.groupFetchAllParticipating === 'function' &&
    typeof sock.groupLeave === 'function',
  );
}

/** Same fail-closed predicate as `buildGetSendSocket` - returns ONLY the three group-sync/leave methods. */
export function buildGetGroupSocket(
  getCurrentSock: () => FakeableSocket | undefined,
  state: RunnerSessionState,
): () => BaileysGroupSocketPort | undefined {
  return () => {
    const sock = getCurrentSock();
    if (!isGroupCapable(sock, state)) {
      return undefined;
    }
    return {
      groupFetchAllParticipating: sock.groupFetchAllParticipating.bind(sock),
      groupLeave: sock.groupLeave.bind(sock),
      selfJid: () => sock.user?.id,
    };
  };
}

/** Moved verbatim from `runner.ts` (P09 U6a) - stubbed in-flight/queue signals until P11 tracks them for real; `pairingInProgress` is real. */
export function buildInventorySnapshot(
  acquiredAtMonotonic: number,
  state: RunnerSessionState,
): () => {
  acquiredAtMonotonic: number;
  inFlightSendCount: number;
  lastConversationActivityAtMonotonic: number | null;
  queueDepth: number;
  pairingInProgress: boolean;
} {
  return () => ({
    acquiredAtMonotonic,
    inFlightSendCount: 0,
    lastConversationActivityAtMonotonic: null,
    queueDepth: 0,
    pairingInProgress: state.linkState === 'pairing',
  });
}
