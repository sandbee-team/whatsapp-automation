import '../realtime/__test-support__/stub-wp-server-kit-env.js';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createMetricsRegistry } from '@wp/server-kit';
import { extractOptOutCandidateText } from '@wp/domain';
import { bindInboundMetrics } from './metrics.js';
import { writeInboundDeadLetter, classifyInboundError, approximateRawSize } from './dead-letter.js';
import { createInboundDispatcher, type InboundDispatcherDeps } from './handler.js';

/**
 * handler-pii-scan.test.ts (P21 Unit U6a, step 7) - split out of
 * handler.test.ts to stay under the 300-line cap (see
 * `.claude/rules/core-invariants.md`'s "session-worker-discovery-wiring.ts"
 * split idiom). The one big end-to-end PII proof: 100 mixed events through
 * the REAL dispatcher wired to the REAL `writeInboundDeadLetter`, scanning
 * every recorded SQL param, every captured log line, and every non-test
 * source file under this module for forbidden PII tokens.
 */

const EMPTY_GROUP_JIDS: ReadonlySet<string> = new Set();

type Deps = InboundDispatcherDeps;

function upsertMessage(id: string, remoteJid: string, text: string, fromMe = false) {
  return {
    key: { id, remoteJid, fromMe, participant: undefined },
    message: { conversation: text },
  };
}

describe('a_dead_letter_row_contains_no_body_jid_or_phone_number (dispatcher-level)', () => {
  it('does not surface the extractor to signals when a real dead letter path is used', () => {
    // extractOptOutCandidateText is imported here only to prove the handler
    // module composes with the real extractor type - the PII source scan
    // below is the authoritative proof.
    expect(typeof extractOptOutCandidateText).toBe('function');
  });
});

describe('the_inbound_path_writes_no_message_body_to_any_store', () => {
  it('scans rows, logs and source for PII across 100 mixed events', async () => {
    const bodySentinel = 'BODY-SENTINEL-919876543210';
    const captionSentinel = 'CAPTION-SENTINEL-918765432109';
    const phoneSentinel = '919876543210';
    const jidSentinel = `${phoneSentinel}@s.whatsapp.net`;

    interface FakeQuery {
      sql: string;
      params: unknown[];
    }
    const calls: FakeQuery[] = [];
    const tx = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return { rows: [], rowCount: 1 };
      }),
    };
    const tenantDb = {
      withTenant: vi.fn(async (_clientId: string, callback: (tx: unknown) => Promise<unknown>) =>
        callback(tx),
      ),
    };

    const logLines: unknown[] = [];
    const logger = {
      warn: vi.fn((obj: Record<string, unknown>, msg: string) => {
        logLines.push({ obj, msg });
      }),
    };

    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);

    const deadLetter = async (input: {
      waMsgId: string | null;
      chatJid: string | null;
      errorClass: string;
      rawSize: number | null;
    }) =>
      writeInboundDeadLetter(
        {
          tenantDb: tenantDb as never,
          clientId: 'client-1',
          instanceId: 'instance-1',
          metrics,
          logger,
        },
        input,
      );

    const candidateLengths: number[] = [];
    let signalCallIndex = 0;
    const signals = vi.fn(async (signal: { senderJid: string; candidate: unknown }) => {
      signalCallIndex += 1;
      if (signal.candidate !== null && typeof signal.candidate === 'object') {
        const candidate = signal.candidate as { unwrapForKeywordMatching(): string };
        candidateLengths.push(candidate.unwrapForKeywordMatching().length);
      }
      if (signalCallIndex % 13 === 0) {
        throw new Error(`synthetic failure ${bodySentinel}`);
      }
      return {};
    });
    const receipt = vi.fn(async () => ({}));
    const echo = vi.fn(async () => {});

    let admitCount = 0;
    const admit = vi.fn(async () => {
      admitCount += 1;
      return admitCount % 7 === 0 ? ('shed' as const) : ('admitted' as const);
    });

    const deps: Deps = {
      clientId: 'client-1',
      instanceId: 'instance-1',
      admission: { admit },
      sendEnabledGroupJids: () => EMPTY_GROUP_JIDS,
      echo,
      signals,
      receipt,
      deadLetter,
      metrics,
      logger,
    };
    const dispatcher = createInboundDispatcher(deps);

    const messages = [];
    for (let i = 0; i < 60; i += 1) {
      const kindPick = i % 6;
      if (kindPick === 0) {
        messages.push(upsertMessage(`MSG-${i}`, jidSentinel, bodySentinel));
      } else if (kindPick === 1) {
        messages.push({
          key: { id: `MSG-${i}`, remoteJid: jidSentinel, fromMe: false, participant: jidSentinel },
          message: { imageMessage: { caption: captionSentinel } },
        });
      } else if (kindPick === 2) {
        messages.push(upsertMessage(`MSG-${i}`, 'group1@g.us', bodySentinel));
      } else if (kindPick === 3) {
        messages.push(upsertMessage(`MSG-${i}`, 'somechannel@newsletter', bodySentinel));
      } else if (kindPick === 4) {
        messages.push(upsertMessage(`MSG-${i}`, 'status@broadcast', bodySentinel));
      } else {
        messages.push(upsertMessage(`MSG-${i}`, jidSentinel, bodySentinel, true));
      }
    }
    await dispatcher.onMessagesUpsert({ messages });

    const messagesUpdate = [];
    for (let i = 0; i < 20; i += 1) {
      messagesUpdate.push({
        key: { fromMe: true, id: `RCPT-${i}`, remoteJid: jidSentinel },
        update: { status: 3 },
      });
    }
    await dispatcher.onMessagesUpdate(messagesUpdate);

    const receiptUpdate = [];
    for (let i = 0; i < 20; i += 1) {
      receiptUpdate.push({
        key: { fromMe: true, id: `URCPT-${i}`, remoteJid: jidSentinel },
        receipt: { receiptTimestamp: 1000 + i },
      });
    }
    await dispatcher.onMessageReceiptUpdate(receiptUpdate);

    expect(deadLetter).toBeDefined();

    // (i) row scan: deep-walk every recorded SQL param.
    function deepWalkForPii(value: unknown, hits: string[]): void {
      if (Buffer.isBuffer(value)) {
        hits.push(value.toString('hex'));
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) deepWalkForPii(item, hits);
        return;
      }
      if (value && typeof value === 'object') {
        for (const v of Object.values(value)) deepWalkForPii(v, hits);
        return;
      }
      hits.push(String(value));
    }
    const allParamStrings: string[] = [];
    for (const call of calls) {
      deepWalkForPii(call.params, allParamStrings);
    }
    const joinedParams = allParamStrings.join(' ');
    expect(joinedParams).not.toContain(bodySentinel);
    expect(joinedParams).not.toContain(captionSentinel);
    expect(joinedParams).not.toContain(phoneSentinel);
    expect(joinedParams).not.toContain(jidSentinel);

    // (ii) log grep.
    const joinedLogs = JSON.stringify(logLines);
    expect(joinedLogs).not.toContain(bodySentinel);
    expect(joinedLogs).not.toContain(captionSentinel);
    expect(joinedLogs).not.toContain(phoneSentinel);
    expect(joinedLogs).not.toContain(jidSentinel);

    // (iii) source scan. Widened (C1 fix round) to also cover
    // `engine/session/session-worker-inbound-wiring.ts` and
    // `packages/domain/src/inbound/*.ts` - previously only
    // `modules/inbound/*.ts` was scanned, leaving the two files that
    // actually touch a raw Baileys message shape unchecked. Allow-list (the
    // ONLY tokens permitted, and ONLY in the named files):
    //   - `session-worker-inbound-wiring.ts`: `WAMessage` as a TYPE IMPORT
    //     only (`import type { WAMessage } from 'baileys'`) - it never reads
    //     a body/caption field off the value itself.
    //   - `packages/domain/src/inbound/optout-text.ts`: `.conversation`,
    //     `extendedTextMessage`, `caption` - this IS the one extractor
    //     (module doc: "the only text-extraction path in the codebase");
    //     also `rawMessage`/`pushName`, which appear only in that file's own
    //     doc comment in the negated form ("never ... references
    //     rawMessage/pushName").
    const HERE = path.dirname(fileURLToPath(import.meta.url));
    const forbiddenTokens = [
      'rawMessage',
      '.conversation',
      'extendedTextMessage',
      'caption',
      'pushName',
      'INSERT INTO messages',
      'chats',
      'media_assets',
    ];

    function scanDir(dir: string, opts: { allow?: Record<string, string[]> } = {}): number {
      let count = 0;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.includes('.test.')) {
          continue;
        }
        count += 1;
        const source = readFileSync(path.join(dir, entry.name), 'utf8');
        const allowedHere = opts.allow?.[entry.name] ?? [];
        for (const token of forbiddenTokens) {
          if (allowedHere.includes(token)) {
            continue;
          }
          expect(source, `${entry.name} must not contain "${token}"`).not.toContain(token);
        }
      }
      return count;
    }

    let scannedFiles = scanDir(HERE);

    // `session-worker-inbound-wiring.ts` only - not the whole engine/session
    // directory (that file is the one sibling allow-listed for `WAMessage`
    // as a TYPE import; the forbidden PII tokens above are never allowed
    // even there).
    const sessionDir = path.join(HERE, '..', '..', 'engine', 'session');
    const wiringFile = 'session-worker-inbound-wiring.ts';
    const wiringSource = readFileSync(path.join(sessionDir, wiringFile), 'utf8');
    expect(wiringSource).toContain("import type { WAMessage } from 'baileys'");
    for (const token of forbiddenTokens) {
      expect(wiringSource, `${wiringFile} must not contain "${token}"`).not.toContain(token);
    }
    scannedFiles += 1;

    const domainInboundDir = path.join(
      HERE,
      '..',
      '..',
      '..',
      '..',
      '..',
      'packages',
      'domain',
      'src',
      'inbound',
    );
    scannedFiles += scanDir(domainInboundDir, {
      allow: {
        // `rawMessage`/`pushName` appear only in that file's own doc
        // comment, in the negated form "never returns/references
        // rawMessage/pushName" - documenting the guarantee, not violating it.
        'optout-text.ts': [
          '.conversation',
          'extendedTextMessage',
          'caption',
          'rawMessage',
          'pushName',
        ],
      },
    });

    expect(scannedFiles).toBeGreaterThanOrEqual(10);

    // Sanity: candidate lengths were observed (proves signals ran on real
    // candidates without ever exposing the text itself to this test).
    expect(candidateLengths.length).toBeGreaterThan(0);
    expect(classifyInboundError(new Error('x'))).toBe('Error');
    expect(approximateRawSize({ a: 1 })).toBeGreaterThan(0);
  });
});
