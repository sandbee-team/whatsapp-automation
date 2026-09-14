import { describe, expect, it } from 'vitest';
import { realtimeChannel, parseRealtimeChannel } from './channel.js';

/**
 * realtime-channel.test.ts (P05 Unit U3a) - proves the SSE channel-name
 * shape from the data/security design row: `client:{client_id}` (no
 * instance) or `client:{client_id}:instance:{instance_id}`, and that two
 * distinct client ids can never collide onto the same channel name.
 */

function randomUuid(): string {
  return crypto.randomUUID();
}

describe('realtimeChannel', () => {
  it('two_clients_never_produce_the_same_channel_name', () => {
    for (let i = 0; i < 500; i += 1) {
      const a = randomUuid();
      const b = randomUuid();
      expect(realtimeChannel(a)).not.toBe(realtimeChannel(b));

      const parsedA = parseRealtimeChannel(realtimeChannel(a));
      expect(parsedA.clientId).toBe(a);
      expect(parsedA.instanceId).toBeUndefined();
    }
  });

  it('builds_the_instance_scoped_channel_name', () => {
    const clientId = randomUuid();
    const instanceId = randomUuid();
    expect(realtimeChannel(clientId, instanceId)).toBe(`client:${clientId}:instance:${instanceId}`);
  });

  it('parses_the_instance_scoped_channel_name_back', () => {
    const clientId = randomUuid();
    const instanceId = randomUuid();
    const parsed = parseRealtimeChannel(realtimeChannel(clientId, instanceId));
    expect(parsed).toEqual({ clientId, instanceId });
  });

  it('throws_on_an_empty_client_id', () => {
    expect(() => realtimeChannel('')).toThrow();
  });

  it('throws_on_a_client_id_containing_a_colon', () => {
    expect(() => realtimeChannel('a:b')).toThrow();
  });

  it('throws_on_an_instance_id_containing_a_colon', () => {
    expect(() => realtimeChannel('client-a', 'inst:1')).toThrow();
  });

  it('parse_throws_on_an_unrecognised_channel_shape', () => {
    expect(() => parseRealtimeChannel('not-a-channel')).toThrow();
  });
});
