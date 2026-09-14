import { bindQueryParams, loadQuery, type TenantDb, type TenantQueryable } from '@wp/db';
import { normaliseJid, waJidFromE164, type Clock, type OptOutCandidateText } from '@wp/domain';
import { logger, type MetricsRegistry } from '@wp/server-kit';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { hashRecipient } from '../../platform/crypto/phone-hash.js';
import type { OptOutMirrorPort } from '../pacing/index.js';
import { touchGroupLastMessage } from '../groups/index.js';
import { detectInboundOptOut, type DetectInboundOptOutResult } from './optout-detect.js';
import type { InboundMetricsHandles } from './metrics.js';

/**
 * message-signals.ts (P21 Unit U4, step 5) - `handleInboundMessageSignals`,
 * the ONE small transaction every inbound message runs through: normalise
 * the sender, touch the two contact timestamps (existing LIVE contacts
 * only - inbound auto-create is deliberately NOT built this phase), and
 * call P14's `detectInboundOptOut`. The post-commit confirmation port
 * (`bindOptOutConfirmationSender`, `modules/pacing/internal/system-send.ts`)
 * is invoked strictly AFTER `withTenant` resolves - never from inside it
 * (P14 review FINDING 7; this module is the caller that owns that rule now).
 *
 * A `@lid` sender with no persisted `contacts.lid_jid` mapping is
 * unattributable (core invariant 6 extended - never guess a contact from
 * digits): NOTHING is touched, no hash is computed (there is no E.164 to
 * hash), and P14's own counter/warning path
 * (`wp_optout_unattributable_total`) is the only signal recorded, via
 * `detectInboundOptOut` itself when the text also happens to match a
 * keyword.
 *
 * PII discipline (ADR 0021, core invariant 6): `senderJid`/`e164`/the
 * candidate text/the matched keyword are NEVER logged or placed in a query
 * parameter beyond what P14's own `detectInboundOptOut` already does
 * (hashes and ids only). `OptOutCandidateText` is read exactly once, via
 * `unwrapForKeywordMatching()`, at the one call site that needs it - never
 * assigned to a variable that outlives that call.
 */

export interface InboundMessageSignal {
  senderJid: string;
  candidate: OptOutCandidateText | null;
  /** `key.remoteJid` (P24 Unit U4b) - the chat jid, present so a `@g.us` chat can touch its `wa_groups.last_message_at` in this same transaction. Optional: every pre-P24 caller/test omits it and the group touch simply never runs. */
  remoteJid?: string | null;
}

export interface MessageSignalsDeps {
  tenantDb: TenantDb;
  clientId: string;
  instanceId: string;
  keyProvider: KeyProvider;
  encVersion?: number;
  metrics: InboundMetricsHandles;
  metricsRegistry?: MetricsRegistry;
  /** U6 wires `syncOptOutMirror` (`modules/contacts`); tests may stub. */
  mirror: OptOutMirrorPort;
  /**
   * Post-commit port. Invoked ONLY after `withTenant` has resolved, never
   * inside it. U6 wires `bindOptOutConfirmationSender`'s returned port.
   */
  onOptedOut: (payload: NonNullable<DetectInboundOptOutResult['optedOut']>) => Promise<void>;
  /**
   * Resolves a persisted lid->pn mapping (`contacts.lid_jid`) inside the
   * tx; returns the pn JID or null. Defaults to `resolveLidFromContacts`.
   */
  resolveLid?: (tx: TenantQueryable, clientId: string, lidJid: string) => Promise<string | null>;
  /** Feeds the `wa_groups.last_message_at` touch's event timestamp (P24 Unit U4b). Defaults to the real wall clock. */
  clock?: Clock;
}

export type MessageSignalsOutcome =
  | { attribution: 'attributed'; optedOut: boolean; touched: true }
  | { attribution: 'unattributable'; optedOut: false; touched: false };

interface ContactRow extends Record<string, unknown> {
  phone_e164: string;
}

/** `SELECT phone_e164 FROM contacts WHERE client_id = $1 AND lid_jid = $2 AND deleted_at IS NULL LIMIT 1` -> the mapped pn JID, or null when no live contact carries this `lid_jid`. */
export async function resolveLidFromContacts(
  tx: TenantQueryable,
  clientId: string,
  lidJid: string,
): Promise<string | null> {
  const result = await tx.query<ContactRow>(
    `SELECT phone_e164 FROM contacts
      WHERE client_id = $1 AND lid_jid = $2 AND deleted_at IS NULL
      LIMIT 1`,
    [clientId, lidJid],
  );
  const row = result.rows[0];
  return row === undefined ? null : waJidFromE164(row.phone_e164);
}

/** `UPDATE contacts SET last_inbound_at = GREATEST(...)` - existing LIVE contacts only; inbound auto-create is deliberately NOT built this phase. */
async function touchContactLastInbound(
  tx: TenantQueryable,
  clientId: string,
  phoneHash: Buffer,
): Promise<void> {
  await tx.query(
    `UPDATE contacts SET last_inbound_at = GREATEST(last_inbound_at, now()), updated_at = now()
      WHERE client_id = $1 AND phone_hash = $2 AND deleted_at IS NULL
      -- client_id = $1`,
    [clientId, phoneHash],
  );
}

/** Runs `touch-inbound-contact.sql` (the `instance_recipient_contacts` UPSERT). */
async function touchInstanceRecipientContact(
  tx: TenantQueryable,
  clientId: string,
  instanceId: string,
  phoneHash: Buffer,
): Promise<void> {
  const query = await loadQuery('touch-inbound-contact');
  const params = bindQueryParams(query, {
    client_id: clientId,
    instance_id: instanceId,
    phone_hash: phoneHash,
  });
  await tx.query(query.text, params);
}

interface TenantKeywordRow extends Record<string, unknown> {
  keyword: string;
}

/** `SELECT keyword FROM tenant_optout_keywords WHERE client_id = $1` - same transaction, same statement shape as every other tenant-scoped read here. */
async function loadTenantKeywords(tx: TenantQueryable, clientId: string): Promise<string[]> {
  const result = await tx.query<TenantKeywordRow>(
    `SELECT keyword FROM tenant_optout_keywords WHERE client_id = $1`,
    [clientId],
  );
  return result.rows.map((row) => row.keyword);
}

/**
 * Runs the whole flow inside ONE `deps.tenantDb.withTenant` transaction, then
 * (only on a successful attributed opt-out) invokes `deps.onOptedOut` after
 * that transaction has committed - never inside it. Any throw inside the
 * transaction propagates to the caller unchanged (U6's dead-letter path).
 */
export async function handleInboundMessageSignals(
  deps: MessageSignalsDeps,
  signal: InboundMessageSignal,
): Promise<MessageSignalsOutcome> {
  const resolveLid = deps.resolveLid ?? resolveLidFromContacts;
  const { optOutDetectedTotal } = deps.metrics;

  const clock = deps.clock ?? { now: () => Date.now() };

  const { outcome, optedOut } = await deps.tenantDb.withTenant(deps.clientId, async (tx) => {
    if (signal.remoteJid !== null && signal.remoteJid !== undefined) {
      await touchGroupLastMessage(tx, {
        clientId: deps.clientId,
        instanceId: deps.instanceId,
        remoteJid: signal.remoteJid,
        at: new Date(clock.now()),
      });
    }

    let resolvedPnJid: string | null = null;
    if (signal.senderJid.includes('@lid')) {
      const provisionallyNormalised = normaliseJid(signal.senderJid);
      resolvedPnJid = await resolveLid(tx, deps.clientId, provisionallyNormalised.jid);
    }

    const normalised = normaliseJid(signal.senderJid, {
      resolveLid: () => resolvedPnJid,
    });

    if (normalised.unattributable || normalised.e164 === null) {
      if (signal.candidate !== null) {
        await detectInboundOptOut(
          {
            tx,
            provider: deps.keyProvider,
            mirror: deps.mirror,
            metricsRegistry: deps.metricsRegistry,
          },
          {
            clientId: deps.clientId,
            instanceId: deps.instanceId,
            senderJid: normalised.jid,
            senderE164: null,
            text: signal.candidate.unwrapForKeywordMatching(),
            tenantKeywords: [],
          },
        );
      }
      return {
        outcome: { attribution: 'unattributable', optedOut: false, touched: false } as const,
        optedOut: undefined,
      };
    }

    const e164 = normalised.e164;
    const phoneHash = hashRecipient(deps.keyProvider, e164);

    await touchContactLastInbound(tx, deps.clientId, phoneHash);
    await touchInstanceRecipientContact(tx, deps.clientId, deps.instanceId, phoneHash);

    let optOutResult: DetectInboundOptOutResult | undefined;
    if (signal.candidate !== null) {
      const tenantKeywords = await loadTenantKeywords(tx, deps.clientId);
      optOutResult = await detectInboundOptOut(
        {
          tx,
          provider: deps.keyProvider,
          mirror: deps.mirror,
          encVersion: deps.encVersion,
          metricsRegistry: deps.metricsRegistry,
        },
        {
          clientId: deps.clientId,
          instanceId: deps.instanceId,
          senderJid: normalised.jid,
          senderE164: e164,
          text: signal.candidate.unwrapForKeywordMatching(),
          tenantKeywords,
        },
      );
      if (optOutResult.optedOut) {
        optOutDetectedTotal.inc();
      }
    }

    return {
      outcome: {
        attribution: 'attributed',
        optedOut: optOutResult?.optedOut !== undefined,
        touched: true,
      } as const,
      optedOut: optOutResult?.optedOut,
    };
  });

  if (optedOut !== undefined) {
    try {
      await deps.onOptedOut(optedOut);
    } catch (err: unknown) {
      logger.error(
        {
          client_id: deps.clientId,
          instance_id: deps.instanceId,
          error_class: err instanceof Error ? err.name : 'UnknownError',
        },
        'handleInboundMessageSignals: onOptedOut port threw',
      );
    }
  }

  return outcome;
}
