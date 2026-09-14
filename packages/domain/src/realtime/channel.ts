/**
 * realtime/channel.ts (P05 Unit U3a) - the SSE channel-name shape from the
 * data/security design row: `client:{client_id}` (client-wide channel every
 * connection subscribes to) or `client:{client_id}:instance:{instance_id}`
 * (opt-in per-instance channel, only added once ownership is proven -
 * app/backend/src/modules/realtime/service.ts). Browser-pure: no Node
 * builtins, no I/O - shared between the backend hub and any future browser
 * client that needs to recognise its own channel names.
 */

export interface RealtimeChannelParts {
  clientId: string;
  instanceId?: string;
}

function assertSegment(label: string, value: string): void {
  if (value.length === 0) {
    throw new Error(`realtimeChannel: ${label} must not be empty`);
  }
  if (value.includes(':')) {
    throw new Error(`realtimeChannel: ${label} must not contain ":" (got "${value}")`);
  }
}

/** Builds the channel name for `clientId`, optionally scoped to `instanceId`. */
export function realtimeChannel(clientId: string, instanceId?: string): string {
  assertSegment('clientId', clientId);
  if (instanceId === undefined) {
    return `client:${clientId}`;
  }
  assertSegment('instanceId', instanceId);
  return `client:${clientId}:instance:${instanceId}`;
}

const CLIENT_ONLY_PATTERN = /^client:([^:]+)$/;
const CLIENT_INSTANCE_PATTERN = /^client:([^:]+):instance:([^:]+)$/;

/** Inverse of `realtimeChannel` - throws on anything that isn't one of the two recognised shapes. */
export function parseRealtimeChannel(name: string): RealtimeChannelParts {
  const instanceMatch = CLIENT_INSTANCE_PATTERN.exec(name);
  if (instanceMatch) {
    return { clientId: instanceMatch[1]!, instanceId: instanceMatch[2]! };
  }

  const clientOnlyMatch = CLIENT_ONLY_PATTERN.exec(name);
  if (clientOnlyMatch) {
    return { clientId: clientOnlyMatch[1]! };
  }

  throw new Error(`parseRealtimeChannel: not a recognised channel name: "${name}"`);
}
