import type { Transition, WaHealth } from '@wp/domain';
import type { InstanceCtx } from '../../modules/instances/repo.js';
import * as instancesRepo from '../../modules/instances/repo.js';
import * as instancesService from '../../modules/instances/service.js';

/**
 * runner-test-instances-adapter.ts (P08 U5a) - the thin adapter binding the
 * runner's `RunnerInstancesPort` shape onto the REAL U4 `modules/instances`
 * repo/service, closing over a resolvable `instanceId` (the runner's own
 * `instanceId` is only known once `seedProbe()` returns, after
 * `createPairingController`/`createSessionRunner` are already built - see
 * runner-test-support.ts's `currentInstanceId` closure). Split out of
 * runner-test-support.ts purely to keep that file under max-lines.
 */

export interface InstancesAdapterOptions {
  ctx: InstanceCtx;
  serviceDeps: instancesService.InstanceServiceDeps;
  /** Reads the CURRENT fence this worker holds - evaluated LAZILY inside each write closure (never snapshotted at build time), mirroring pairing's `repoCtx` pattern: engine writes made after `start()` need the live value, not whatever the fence was at composition time (before any lease was even acquired). */
  currentFence: () => bigint;
  workerId: string;
  currentInstanceId: () => string;
}

export function buildInstancesAdapter(options: InstancesAdapterOptions) {
  const { ctx, serviceDeps, currentFence, workerId, currentInstanceId } = options;

  return {
    applyEngineTransition: (
      transition: Transition,
      fromHealth: WaHealth,
      meta: instancesService.ApplyEngineTransitionMeta,
    ) =>
      instancesService.applyEngineTransition(
        serviceDeps,
        currentInstanceId(),
        fromHealth,
        transition,
        meta,
      ),
    runLoggedOutFlow: (authStoreArg: { purge(fence: bigint): Promise<{ purged: boolean }> }) =>
      instancesService.runLoggedOutFlow(serviceDeps, {
        instanceId: currentInstanceId(),
        fence: currentFence(),
        workerId,
        authStore: authStoreArg as never,
      }),
    markLinkedConnected: (input: { ownerJid: string | null; phoneE164: string | null }) =>
      instancesRepo.markLinkedConnected(ctx, {
        instanceId: currentInstanceId(),
        fence: currentFence(),
        workerId,
        ownerJid: input.ownerJid,
        phoneE164: input.phoneE164,
      }),
    readSessionEpoch: (instanceId: string) => instancesRepo.readSessionEpoch(ctx, instanceId),
  };
}
