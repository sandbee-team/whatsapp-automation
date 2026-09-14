import type { WaHealth, WaLinkState } from '@wp/domain';
import type { SessionRunnerRegistry } from '../../engine/session/registry.js';

/**
 * adapter-types.ts (P08 Unit U6a) - the canonical provider-boundary
 * interface (`LinkChallenge`/`ChannelLink`) plus `createBaileysChannelLink`'s
 * own injected-dependency surface, split out of adapter.ts to stay under
 * max-lines. `LinkChallenge`/`ChannelLink`'s SHAPE is canon, copied verbatim
 * from the architecture blueprint so a Cloud API adapter can drop in at v2
 * with the exact same public surface - never add/rename a field here without
 * an ADR.
 */

export type LinkChallenge =
  | { type: 'qr'; payload: string; expiresAt: Date; attemptsLeft: number }
  | { type: 'code'; payload: string; expiresAt: Date; attemptsLeft: number }
  | { type: 'redirect'; url: string; expiresAt: Date };

export interface ChannelLink {
  readonly kind: 'baileys';
  beginLink(
    instanceId: string,
    opts: { method?: 'qr' | 'code'; phone?: string },
  ): Promise<LinkChallenge>;
  refreshChallenge(instanceId: string): Promise<LinkChallenge | null>;
  linkStatus(
    instanceId: string,
  ): Promise<{ linkState: WaLinkState; healthState: WaHealth; identityRef?: string }>;
  unlink(instanceId: string, reason: 'user_request' | 'deleted'): Promise<void>;
}

/**
 * The narrow slice of `modules/instances` this adapter needs, ALREADY
 * scoped per tenant by whoever constructs it (mirrors
 * `engine/session/runner-test-instances-adapter.ts`'s `buildInstancesAdapter`
 * pattern: the real repo/service calls need an `InstanceCtx`/fence/authStore
 * the composition root supplies via closure - this port intentionally takes
 * only `instanceId` so `ChannelLink`'s own public methods can stay exactly
 * canon-shaped with no extra tenant parameter).
 */
export interface ChannelLinkInstancesPort {
  readSessionEpoch(
    instanceId: string,
  ): Promise<{ sessionEpoch: number; healthState: string; linkState: string }>;
  beginPairingIntent(instanceId: string): Promise<boolean>;
  /** `false` means the window is exhausted and NOT reset - `refreshChallenge` must return `null` for that instanceId, never retry on its own. */
  resetPairingWindow(instanceId: string): Promise<boolean>;
  /** Idempotent by contract (P07 purge + U4 fence-guarded write) - safe to call twice or with no live socket/creds. */
  runLoggedOutFlow(instanceId: string): Promise<void>;
}

export interface ChannelLinkClock {
  now(): number;
}

export interface CreateBaileysChannelLinkDeps {
  registry: SessionRunnerRegistry;
  instances: ChannelLinkInstancesPort;
  clock: ChannelLinkClock;
}
