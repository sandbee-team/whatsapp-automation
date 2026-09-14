/**
 * groups/index.ts (P24 groups-messaging, Unit U2, step 1) - the module's
 * public re-export surface, per the layering convention every other
 * `@wp/domain` submodule follows (see `contacts/index.ts`,
 * `broadcast/index.ts`). `GROUP_RISK_DISCLOSURE` is NOT re-exported here -
 * it lives in `copy/disclosures.ts` and is exported once from the package
 * root, same reasoning `broadcast/index.ts`'s own header gives for
 * `BROADCAST_DISCLOSURE`.
 */
export {
  MAX_TRACKED_PARTICIPANT_DEVICES,
  DEVICES_PER_PARTICIPANT_ESTIMATE,
  GROUP_SYNC_MIN_INTERVAL_MS,
} from './constants.js';

export { isGroupJid, groupRecipientHashInput } from './group-jid.js';

export {
  GROUP_SEND_INELIGIBILITY_REASONS,
  API_TIME_REJECTION_REASONS,
  canSendToGroup,
  canEnableGroupSend,
  deriveTrackedParticipantDevices,
  type GroupSendIneligibilityReason,
  type GroupRole,
  type GroupSendEligibility,
  type CanSendToGroupInput,
  type CanEnableGroupSendInput,
} from './send-eligibility.js';
