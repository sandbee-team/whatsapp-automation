import { shouldIgnoreJid, extractOptOutCandidateText, type OptOutCandidateText } from '@wp/domain';
import {
  receiptsFromMessagesUpdate,
  receiptsFromReceiptUpdate,
  type InboundReceipt,
} from './receipts.js';
import { classifyInboundError, approximateRawSize, type DeadLetterInput } from './dead-letter.js';
import type { InboundMetricsHandles } from './metrics.js';

/**
 * handler.ts (P21 Unit U6a, step 7) - the headless inbound dispatcher: one
 * `onMessagesUpsert`/`onMessagesUpdate`/`onMessageReceiptUpdate` per session
 * worker socket, each NEVER rejecting. Per message: `fromMe` routes to echo
 * capture only (never admission, never the filter, never signals); else the
 * message-scope filter (`shouldIgnoreJid`) drops platform noise and
 * un-allowlisted groups; else admission sheds above the per-instance
 * ceiling with NOTHING else happening (no buffering, no retry); else
 * `extractOptOutCandidateText` feeds the message-signals port. Per receipt
 * (parsed upstream by `receipts.ts`): the receipt-scope filter only drops
 * platform noise (status/newsletter) - a missing jid or un-allowlisted group
 * jid is never dropped in this scope, and receipts NEVER call
 * `admission.admit` (U2's `shouldIgnoreJid` receipt branch structurally
 * never reads the group set either).
 *
 * ONE try/catch per event: a throw is one dead letter
 * (`writeInboundDeadLetter`, bound by the caller), never a socket teardown
 * and never a throw past this dispatcher's own boundary. The dispatcher
 * never logs a JID, phone number or body - the candidate object is passed
 * straight into `signals` and never stored on `this`, in a closure array,
 * or in a log line (ADR 0021, core invariant 6).
 */

export interface InboundDispatcherDeps {
  clientId: string;
  instanceId: string;
  admission: { admit(clientId: string, instanceId: string): Promise<'admitted' | 'shed'> };
  /** The session worker's own background-refreshed allow-list (`modules/groups/send-enabled-jids.ts`), synchronous per this dependency's own contract. */
  sendEnabledGroupJids: () => ReadonlySet<string>;
  /** `captureEchoIfFromMe` bound to this session. */
  echo: (message: unknown) => Promise<void>;
  signals: (signal: {
    senderJid: string;
    candidate: OptOutCandidateText | null;
    remoteJid: string | null;
  }) => Promise<unknown>;
  receipt: (receipt: InboundReceipt) => Promise<unknown>;
  /** `writeInboundDeadLetter` bound to this session. */
  deadLetter: (input: DeadLetterInput) => Promise<unknown>;
  metrics: InboundMetricsHandles;
  logger: { warn(obj: Record<string, unknown>, msg: string): void };
}

export interface InboundDispatcher {
  /** Each returns a Promise that resolves after EVERY event in the payload has been processed or dead-lettered. NEVER rejects. */
  onMessagesUpsert(payload: unknown): Promise<void>;
  onMessagesUpdate(payload: unknown): Promise<void>;
  onMessageReceiptUpdate(payload: unknown): Promise<void>;
}

interface RawMessageKey {
  fromMe?: boolean | null;
  id?: string | null;
  remoteJid?: string | null;
  participant?: string | null;
}

interface RawMessage {
  key?: RawMessageKey;
}

function readMessages(payload: unknown): RawMessage[] {
  if (
    !payload ||
    typeof payload !== 'object' ||
    !Array.isArray((payload as { messages?: unknown }).messages)
  ) {
    return [];
  }
  return (payload as { messages: RawMessage[] }).messages;
}

export function createInboundDispatcher(deps: InboundDispatcherDeps): InboundDispatcher {
  const { inboundEventsTotal } = deps.metrics;

  /**
   * `deps.deadLetter` is a port; `writeInboundDeadLetter` never throws by
   * contract, but the dispatcher must not depend on the PORT PASSED IN
   * honouring that contract (a composition bug or a test double can still
   * reject). A rejecting dead-letter call must never itself reject the
   * dispatcher's per-event promise - log the error name only and continue.
   */
  async function safeDeadLetter(input: DeadLetterInput): Promise<void> {
    try {
      await deps.deadLetter(input);
    } catch (err) {
      deps.logger.warn(
        { err: err instanceof Error ? err.name : 'unknown' },
        'inbound dispatcher: deadLetter port rejected, event dropped after this point',
      );
    }
  }

  async function processMessage(message: RawMessage): Promise<void> {
    let key: RawMessageKey | undefined;
    let remoteJid: string | null = null;
    try {
      if (!message || typeof message !== 'object') {
        inboundEventsTotal.inc({ kind: 'ignored' });
        return;
      }

      key = message.key;
      remoteJid = key?.remoteJid ?? null;

      if (key?.fromMe === true) {
        inboundEventsTotal.inc({ kind: 'echo' });
        await deps.echo(message);
        return;
      }

      if (
        shouldIgnoreJid(remoteJid, {
          scope: 'message',
          sendEnabledGroupJids: deps.sendEnabledGroupJids(),
        })
      ) {
        inboundEventsTotal.inc({ kind: 'ignored' });
        return;
      }

      const decision = await deps.admission.admit(deps.clientId, deps.instanceId);
      if (decision === 'shed') {
        // admission already counted the shed event; nothing else happens.
        return;
      }

      const senderJid = key?.participant ?? remoteJid;
      if (!senderJid) {
        inboundEventsTotal.inc({ kind: 'ignored' });
        return;
      }

      inboundEventsTotal.inc({ kind: 'message' });
      await deps.signals({
        senderJid,
        candidate: extractOptOutCandidateText(message),
        remoteJid,
      });
    } catch (err) {
      await safeDeadLetter({
        waMsgId: key?.id ?? null,
        chatJid: remoteJid,
        errorClass: classifyInboundError(err),
        rawSize: approximateRawSize(message),
      });
    }
  }

  async function processReceipt(receipt: InboundReceipt): Promise<void> {
    try {
      if (
        shouldIgnoreJid(receipt.remoteJid, {
          scope: 'receipt',
          sendEnabledGroupJids: deps.sendEnabledGroupJids(),
        })
      ) {
        inboundEventsTotal.inc({ kind: 'ignored' });
        return;
      }
      inboundEventsTotal.inc({ kind: 'receipt' });
      await deps.receipt(receipt);
    } catch (err) {
      await safeDeadLetter({
        waMsgId: receipt.waMsgId,
        chatJid: receipt.remoteJid,
        errorClass: classifyInboundError(err),
        rawSize: null,
      });
    }
  }

  return {
    async onMessagesUpsert(payload: unknown): Promise<void> {
      const messages = readMessages(payload);
      for (const message of messages) {
        await processMessage(message);
      }
    },
    async onMessagesUpdate(payload: unknown): Promise<void> {
      const receipts = receiptsFromMessagesUpdate(payload);
      for (const receipt of receipts) {
        await processReceipt(receipt);
      }
    },
    async onMessageReceiptUpdate(payload: unknown): Promise<void> {
      const receipts = receiptsFromReceiptUpdate(payload);
      for (const receipt of receipts) {
        await processReceipt(receipt);
      }
    },
  };
}
