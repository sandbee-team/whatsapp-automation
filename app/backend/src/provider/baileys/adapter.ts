import type { WaHealth, WaLinkState } from '@wp/domain';
import type { ChannelLink, CreateBaileysChannelLinkDeps, LinkChallenge } from './adapter-types.js';
import { classifySendError } from './error-map.js';
import type {
  MessageTransport,
  TransportCapabilities,
  WaMessagePayload,
} from '../provider.types.js';
import { TransportSendError } from '../provider.types.js';

/**
 * adapter.ts (P08 Unit U6a; P11 Unit U2 adds `createBaileysMessageTransport`
 * below) - the Baileys halves of the provider-boundary interface:
 * `ChannelLink` (pairing/unlink, P08) and `MessageTransport` (send, P11).
 *
 * `beginLink`/`refreshChallenge` are the INTENT seam only: they write the
 * pairing-window bookkeeping (`beginPairingIntent`/`resetPairingWindow`) and
 * return a PENDING challenge shape (`payload: ''`) documenting that the REAL
 * QR/code payload arrives later via the runner's own SSE publish
 * (`engine/session/pairing.ts`'s `onQr`/`QrPublishEvent`) once Baileys itself
 * emits it - this adapter has no socket of its own to ask for one
 * synchronously. Kept honest per the task: a v2 Cloud API `ChannelLink`
 * adapter's `beginLink` would instead return a REAL `{ type: 'redirect', url
 * }` challenge synchronously, no async seam needed - that asymmetry is
 * Baileys-specific, not something this interface should paper over.
 *
 * `unlink` is the ONE legal `sock.logout(` call site in the entire repo (see
 * `logout-call-sites.test.ts`'s allow-list) - `.logout()` is best-effort
 * against WhatsApp itself (a network-down provider is not a reason to skip
 * the LOCAL purge), so any error it throws is swallowed into a warn-level
 * outcome and `runLoggedOutFlow` ALWAYS runs after, unconditionally. This is
 * idempotent by construction: calling `unlink` twice, or with no live socket
 * (registry empty / no `getSock`) or no auth material to purge, is always
 * safe - `runLoggedOutFlow`'s own idempotency is P07 purge's contract, not
 * re-implemented here.
 */

const QR_TTL_MS = 45_000;
const MAX_ATTEMPTS = 5;

function pendingChallenge(method: 'qr' | 'code' | undefined, now: number): LinkChallenge {
  return {
    type: method ?? 'qr',
    payload: '',
    expiresAt: new Date(now + QR_TTL_MS),
    attemptsLeft: MAX_ATTEMPTS,
  };
}

async function bestEffortLogout(
  registry: CreateBaileysChannelLinkDeps['registry'],
  instanceId: string,
): Promise<void> {
  const handle = registry.get(instanceId);
  const sock = handle?.getSock?.();
  if (!sock) {
    return;
  }
  try {
    await sock.logout();
  } catch {
    // Best-effort: WhatsApp-side logout failing (network down, already
    // logged out server-side, etc.) must never block the LOCAL purge below
    // - fail-safe means we still forget our own auth material either way.
    // No logger is injected into this unit (kept to the task's dep list);
    // a future wiring unit may thread one through if this needs surfacing.
  }
}

export function createBaileysChannelLink(deps: CreateBaileysChannelLinkDeps): ChannelLink {
  const { registry, instances, clock } = deps;

  return {
    kind: 'baileys',

    async beginLink(instanceId, opts) {
      await instances.beginPairingIntent(instanceId);
      return pendingChallenge(opts.method, clock.now());
    },

    async refreshChallenge(instanceId) {
      const legal = await instances.resetPairingWindow(instanceId);
      if (!legal) {
        // Window exhausted and NOT reset - NO retry timer anywhere; the
        // caller (route/dashboard) decides what "null" means to the user.
        return null;
      }
      return pendingChallenge(undefined, clock.now());
    },

    async linkStatus(instanceId) {
      const read = await instances.readSessionEpoch(instanceId);
      return {
        linkState: read.linkState as WaLinkState,
        healthState: read.healthState as WaHealth,
      };
    },

    async unlink(instanceId, _reason) {
      void _reason;
      await bestEffortLogout(registry, instanceId);
      await instances.runLoggedOutFlow(instanceId);
    },
  };
}

/**
 * The narrow sending surface `createBaileysMessageTransport` needs from a
 * live Baileys socket - deliberately its OWN small port, not a reuse of
 * `RunnerHandle.getSock` (whose return type is scoped to `unlink`'s single
 * legal `.logout()` call site, per that file's own allow-list test). The
 * composition root (a later P11 unit) supplies a lookup that resolves to
 * this shape once a real socket is available; tests here use a fake.
 */
export interface BaileysSendSocketPort {
  sendMessage(
    jid: string,
    content: Record<string, unknown>,
  ): Promise<{ id?: string | null } | undefined>;
}

export interface CreateBaileysMessageTransportDeps {
  /** Resolves the live send-capable socket for `instanceId`, or `undefined` if none is open (no network I/O - a local lookup only). */
  getSendSocket(instanceId: string): BaileysSendSocketPort | undefined;
}

/**
 * P24 groups-messaging (Unit U3, step 4/5) - the narrow group-sync/leave
 * surface `RunnerHandle.getGroupSocket` exposes. Deliberately its OWN small
 * port, same reasoning as `BaileysSendSocketPort` above: NEVER the raw
 * socket, never `.logout()`, and never any group membership/settings
 * management method (`scripts/check-forbidden-mechanisms.ts`'s own ban list
 * names those identifiers explicitly - WP never manages group membership or
 * settings). `groupFetchAllParticipating`/`groupLeave` are the only two
 * calls this product makes into a group.
 */
export interface BaileysGroupSocketPort {
  groupFetchAllParticipating(): Promise<
    Record<
      string,
      {
        id: string;
        subject?: string;
        participants: Array<{ id: string; admin?: 'admin' | 'superadmin' | null }>;
        announce?: boolean;
        creation?: number;
      }
    >
  >;
  groupLeave(jid: string): Promise<void>;
  selfJid(): string | undefined;
}

/**
 * `maxMediaBytes` is the LARGEST accepted cap across both media kinds
 * (accepted scope item 3: image 5 MB, document 20 MB) - `document`'s 20 MB
 * wins. `kinds` now reflects real translations below, not an aspirational
 * claim (the 2026-09-14 go-live fix this replaces).
 */
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

const CAPABILITIES: TransportCapabilities = Object.freeze({
  kinds: ['text', 'image', 'document'] as const,
  groups: true,
  maxMediaBytes: MAX_MEDIA_BYTES,
  requiresOptIn: false,
});

/**
 * Builds the exact Baileys 7.0.0-rc14 content shape per kind
 * (`lib/Types/Message.d.ts:37-40`, verified against the pinned source -
 * see this dispatch's own report): image -> `{ image: { stream }, caption? }`;
 * document -> `{ document: { stream }, mimetype, fileName, caption? }`. A
 * `stream` is accepted directly as a `WAMediaUpload` - never buffered here or
 * anywhere upstream (`dispatch.ts` resolves the object-store stream at
 * DISPATCH time, never at enqueue). A kind with no translation still throws
 * (unreachable today - the contract's discriminated union is exhaustive -
 * but a future caller widening the union without widening this function
 * must fail loudly, not silently send the wrong thing - the exact bug this
 * function replaces).
 */
function toWaContent(msg: WaMessagePayload): Record<string, unknown> {
  if (msg.kind === 'text') {
    return { text: msg.text };
  }
  if (msg.kind === 'image') {
    return { image: { stream: msg.stream }, ...(msg.caption ? { caption: msg.caption } : {}) };
  }
  if (msg.kind === 'document') {
    return {
      document: { stream: msg.stream },
      mimetype: msg.mimeType,
      fileName: msg.fileName,
      ...(msg.caption ? { caption: msg.caption } : {}),
    };
  }
  const unreachable: never = msg;
  throw new Error(
    `baileys adapter: no wire translation for message kind "${(unreachable as { kind: string }).kind}"`,
  );
}

/**
 * The `MessageTransport` half (P11 Unit U2, step 4). `send()` rejects with
 * `TransportSendError` (never resolves an error-shaped value) and enforces
 * NOTHING about timeouts itself - the caller (dispatch, P11 U4) wraps this
 * call under `TIMING.sendTimeoutMs`; this function's own promise simply
 * settles whenever the underlying socket call settles. `isReady()` performs
 * NO network I/O - it only checks whether `getSendSocket` currently returns
 * a socket for this instance.
 */
export function createBaileysMessageTransport(
  deps: CreateBaileysMessageTransportDeps,
): MessageTransport {
  const { getSendSocket } = deps;

  return {
    kind: 'baileys',
    capabilities: CAPABILITIES,

    isReady(instanceId) {
      return getSendSocket(instanceId) !== undefined;
    },

    async send(instanceId, msg) {
      const sock = getSendSocket(instanceId);
      if (!sock) {
        throw new TransportSendError('not_connected', `no live socket for instance ${instanceId}`);
      }
      try {
        const result = await sock.sendMessage(msg.to, toWaContent(msg));
        const providerMsgId = result?.id;
        if (!providerMsgId) {
          throw new TransportSendError('unknown', 'provider returned no message id');
        }
        return { providerMsgId };
      } catch (err) {
        if (err instanceof TransportSendError) {
          throw err;
        }
        const { sendErrorClass, retryAfterMs } = classifySendError(err, { recipientJid: msg.to });
        const message = err instanceof Error ? err.message : 'provider send failed';
        throw new TransportSendError(sendErrorClass, message, retryAfterMs);
      }
    },
  };
}
