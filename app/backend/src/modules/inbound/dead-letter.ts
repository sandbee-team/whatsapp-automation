import { createHash } from 'node:crypto';
import type { TenantDb } from '@wp/db';
import type { InboundMetricsHandles } from './metrics.js';

/**
 * dead-letter.ts (P21 Unit U6a, step 7) - one `inbound_dead_letters` row per
 * event whose handler threw, written in its OWN transaction so a failing
 * dead-letter write never blocks the next event. Ids and hashes only: no
 * body, no JID, no phone number anywhere in the row or in any log line
 * (ADR 0021, core invariant 6). `error_class` is bounded and PII-free - a pg
 * error becomes `pg_<SQLSTATE>`, anything else becomes a sanitised
 * `err.name` - NEVER `err.message` (a pg error's `detail`/`where` can carry
 * row values; same discipline as `modules/queue/echo-capture.ts`'s catch).
 */

export interface DeadLetterDeps {
  tenantDb: TenantDb;
  clientId: string;
  instanceId: string;
  metrics: InboundMetricsHandles;
  logger: { warn(obj: Record<string, unknown>, msg: string): void };
}

export interface DeadLetterInput {
  waMsgId: string | null;
  chatJid: string | null;
  errorClass: string;
  rawSize: number | null;
}

const SANITISED_NAME_RE = /[^A-Za-z0-9_]/g;

function hasPgCode(err: unknown): err is { code: string } {
  return (
    typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string'
  );
}

/**
 * Bounded, PII-free class for a thrown value: a pg error (an object with a
 * string `code`) becomes `pg_<SQLSTATE>`; an `Error` (or error-shaped object
 * with a `name`) becomes `err.name` sanitised to `/^[A-Za-z0-9_]{1,64}$/`;
 * anything else becomes `'unknown'`. NEVER the message.
 */
export function classifyInboundError(err: unknown): string {
  if (hasPgCode(err)) {
    return `pg_${err.code}`;
  }
  const name = err instanceof Error ? err.name : hasName(err) ? err.name : null;
  if (name === null) {
    return 'unknown';
  }
  const sanitised = name.replace(SANITISED_NAME_RE, '').slice(0, 64);
  return sanitised === '' ? 'unknown' : sanitised;
}

function hasName(err: unknown): err is { name: string } {
  return (
    typeof err === 'object' && err !== null && typeof (err as { name?: unknown }).name === 'string'
  );
}

/**
 * Approximate wire size: `Buffer.byteLength(JSON.stringify(value))`, or
 * `null` when the value cannot be serialised (e.g. a circular structure).
 * The serialised string is used for its length only and dropped immediately
 * - it is never stored or logged.
 */
export function approximateRawSize(value: unknown): number | null {
  try {
    const serialised = JSON.stringify(value);
    if (serialised === undefined) {
      return null;
    }
    return Buffer.byteLength(serialised);
  } catch {
    return null;
  }
}

/**
 * Writes ONE `inbound_dead_letters` row in its OWN `withTenant` transaction
 * - never the same transaction as the event that threw, so a failing
 * dead-letter write never rolls back or blocks whatever the caller does
 * next. `chat_jid_hash` is `sha256(chatJid)` (null when no jid, where "no
 * jid" is `null` OR an empty/whitespace-only string - an empty string is
 * never a real jid, so hashing it would produce a misleadingly "present"
 * hash for a jid that was never actually known); the jid itself is read
 * once to compute the hash and never stored or logged.
 * NEVER throws: a failing insert increments `wp_inbound_dead_letters_total
 * {error_class="persist_failed"}`, warns with ids only, and resolves
 * `'persist_failed'` - the caller (the dispatcher) must be able to continue
 * to the next event regardless of whether the dead letter itself persisted.
 */
export async function writeInboundDeadLetter(
  deps: DeadLetterDeps,
  input: DeadLetterInput,
): Promise<'written' | 'persist_failed'> {
  const chatJidHash =
    input.chatJid === null || input.chatJid.trim() === ''
      ? null
      : createHash('sha256').update(input.chatJid).digest();

  try {
    await deps.tenantDb.withTenant(deps.clientId, (tx) =>
      tx.query(
        `INSERT INTO inbound_dead_letters (client_id, instance_id, wa_msg_id, chat_jid_hash, error_class, raw_size)
         VALUES ($1, $2, $3, $4, $5, $6)
         -- client_id = $1`,
        [
          deps.clientId,
          deps.instanceId,
          input.waMsgId,
          chatJidHash,
          input.errorClass,
          input.rawSize,
        ],
      ),
    );
    deps.metrics.inboundDeadLettersTotal.inc({ error_class: input.errorClass });
    return 'written';
  } catch {
    deps.metrics.inboundDeadLettersTotal.inc({ error_class: 'persist_failed' });
    deps.logger.warn(
      { client_id: deps.clientId, instance_id: deps.instanceId },
      'writeInboundDeadLetter: insert failed, counted as persist_failed',
    );
    return 'persist_failed';
  }
}
