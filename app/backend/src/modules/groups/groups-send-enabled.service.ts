import { canEnableGroupSend, MAX_TRACKED_PARTICIPANT_DEVICES } from '@wp/domain';
import type { GroupSummary } from '@wp/contracts';
import { provisioningRepo } from '../tenancy/index.js';
import {
  getGroupForUpdate,
  otherEnabledDevicesTotal,
  enabledDevicesTotal,
  setSendEnabled,
  lockInstanceForGroupsEnable,
} from './groups.repo.js';
import {
  GroupInstanceNotFoundError,
  GroupNotFoundError,
  GroupNotSendableError,
} from './groups.errors.js';
import { toGroupSummary } from './groups-summary.js';
import type { GroupsServiceDeps } from './groups.service.js';

/**
 * groups-send-enabled.service.ts (P24 C2 fix round, Fix 1) - `setGroupSendEnabled`
 * moved out of `groups.service.ts` (which sat at the 300-line cap) into its
 * own sibling module, unchanged in its public name/signature (re-exported
 * from `groups.public.ts` under the same name - the routes import does not
 * change). The enable path now locks the tenant's INSTANCE row first, inside
 * the same transaction, before reading the sibling device-budget total -
 * the single serialization point that closes the two-different-groups
 * device-budget race (`groups-get.sql`'s own per-group `FOR UPDATE` cannot
 * serialize two different group rows against each other).
 */
export async function setGroupSendEnabled(
  deps: GroupsServiceDeps,
  input: { clientId: string; id: string; userId: string; enable: boolean },
): Promise<GroupSummary> {
  return deps.tenantDb.withTenant(input.clientId, async (tx) => {
    const current = await getGroupForUpdate(tx, { clientId: input.clientId, id: input.id });
    if (!current || current.left_at !== null) {
      throw new GroupNotFoundError();
    }

    // Idempotent no-op: a PATCH to the current value returns 200 with the
    // row and writes no audit row (never a redundant transition/event) -
    // resolved before the instance lock, since a no-op never contends on
    // the device budget.
    if (current.send_enabled === input.enable) {
      return toGroupSummary(current, { sendable: current.send_enabled, reason: null });
    }

    if (input.enable) {
      // Lock the tenant's instance row FIRST - the second concurrent enable
      // for this instance blocks here until the first COMMITs, so the
      // sibling total read next is never stale (Fix 1).
      const lockedInstanceId = await lockInstanceForGroupsEnable(tx, {
        clientId: input.clientId,
        instanceId: current.instance_id,
      });
      if (!lockedInstanceId) {
        throw new GroupInstanceNotFoundError();
      }

      const trackedDevicesOtherEnabledGroups = await otherEnabledDevicesTotal(tx, {
        clientId: input.clientId,
        instanceId: current.instance_id,
        id: input.id,
      });
      const eligibility = canEnableGroupSend({
        isAnnounce: current.is_announce,
        ourRole: current.our_role,
        // `canEnableGroupSend` never branches on this field (GROUP_CAP_ZERO_AT_TIER
        // is deliberately not a refusal at enable time, per its own doc comment) -
        // passed through for interface parity with `canSendToGroup`, not read.
        effGroupDailyCap: 0,
        trackedDevicesOtherEnabledGroups,
        groupTrackedDevices: current.tracked_participant_devices,
      });
      if (!eligibility.sendable) {
        throw new GroupNotSendableError(
          eligibility.reason === 'DEVICE_BUDGET_EXCEEDED'
            ? {
                reason: 'DEVICE_BUDGET_EXCEEDED',
                trackedDevicesEnabledTotal: trackedDevicesOtherEnabledGroups,
                groupTrackedDevices: current.tracked_participant_devices,
                max: MAX_TRACKED_PARTICIPANT_DEVICES,
              }
            : { reason: 'ANNOUNCE_MEMBER_ONLY' },
        );
      }
    }

    const updated = await setSendEnabled(tx, {
      clientId: input.clientId,
      id: input.id,
      enable: input.enable,
      userId: input.userId,
    });
    if (!updated) {
      throw new GroupNotFoundError();
    }

    const trackedDevicesEnabledTotal = await enabledDevicesTotal(tx, {
      clientId: input.clientId,
      instanceId: current.instance_id,
    });
    await provisioningRepo.insertAuditLog(tx, {
      clientId: input.clientId,
      actorType: 'user',
      actorUserId: input.userId,
      action: input.enable ? 'group.send_enabled' : 'group.send_disabled',
      targetType: 'wa_group',
      targetId: input.id,
      metadata: {
        trackedDevicesEnabledTotal,
        groupTrackedDevices: current.tracked_participant_devices,
      },
    });

    return toGroupSummary(updated, { sendable: updated.send_enabled, reason: null });
  });
}
