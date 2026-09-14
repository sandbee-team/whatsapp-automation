import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useMultiFileAuthState, type WAMessage } from 'baileys';
import { computeContentHash } from '../../src/engine/queue/content-hash.js';
import {
  createBaileysSocket,
  type SocketFactoryLogger,
} from '../../src/provider/baileys/socket-factory.js';
import {
  ALL_BAILEYS_EVENTS,
  deriveKindAndText,
  echoContentHashFields,
  redactJid,
  redactKey,
  redactText,
  shapeOf,
} from './spike-2-echo-redaction.js';

/**
 * spike-2-echo.ts (P12 step 10) - SPIKE-2: a SCRIPTED, HUMAN-OPERATED runner,
 * NOT an automated test. Never picked up by vitest (no `.test.` segment,
 * lives under `app/backend/test/` - root config claims `app/*\/tests/**`
 * (plural) and `app/backend/vitest.config.ts` claims only
 * `src/**\/*.integration.test.ts`; neither matches this path). Outside
 * `app/backend/tsconfig.json`'s `rootDir: "src"` and NOT in any `tsc -b`
 * project graph, same reason `db/tests/**` sits outside `db/tsconfig.json`'s
 * `include: ["src"]` - run directly with `tsx`.
 *
 * PURPOSE: find out whether WhatsApp replays our own `fromMe` sends back to
 * a reconnecting linked device, under the EXACT pinned P08 socket config
 * (`syncFullHistory:false`, `shouldSyncHistoryMessage:()=>false`,
 * `markOnlineOnConnect:false` - see `socket-factory.ts`). Constructs its
 * socket via the real, unmodified `createBaileysSocket` - never a hand-rolled
 * config - so a pass/fail here is evidence about production, not a mock.
 *
 * REDACTION POLICY: see `spike-2-echo-redaction.ts`'s header - every
 * redacting helper lives there; this file never emits a raw JID user part,
 * message body, or QR/pairing payload to any log line.
 *
 * RAW LOG: `app/backend/test/manual/.local/spike-2-echo-<runId>.log`,
 * append-only. `.local/` is local-only evidence (no VCS at all - ADR 0003;
 * `scripts/check-tree.ts` only inspects the tree two levels deep and never
 * recurses into `test/`). Operator attaches excerpts to
 * `docs/evidence/P12-spike-2-echo.md` by hand.
 *
 * STAGES (run one at a time; each prints exactly what to do next):
 *   tsx app/backend/test/manual/spike-2-echo.ts pair
 *   tsx app/backend/test/manual/spike-2-echo.ts trial <n> <bucket:30s|5m|10m>
 *   tsx app/backend/test/manual/spike-2-echo.ts observe <n>
 *
 * NEVER writes a synthetic or default trial result. An incomplete trial
 * (operator interrupt, socket never reaches `open`, process killed) is
 * recorded INCOMPLETE, never as a negative - core invariant 7.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = join(__dirname, '.local', 'auth-state');
const LOG_DIR = join(__dirname, '.local');
const RUN_ID = new Date().toISOString().replace(/[:.]/gu, '-');
const LOG_PATH = join(LOG_DIR, `spike-2-echo-${RUN_ID}.log`);
const OBSERVATION_WINDOW_MS = 15 * 60_000;
const OFFLINE_BUCKET_MS: Record<string, number> = {
  '30s': 30_000,
  '5m': 5 * 60_000,
  '10m': 10 * 60_000,
};

function ensureLogDir(): void {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
}

/** Append one JSON line to the local raw log. Never throws on the operator's behalf - a log-write failure must not crash a live 15-minute observation window. */
function logLine(record: Record<string, unknown>): void {
  ensureLogDir();
  const line = JSON.stringify({ t: new Date().toISOString(), ...record });
  try {
    appendFileSync(LOG_PATH, line + '\n', 'utf8');
  } catch (err) {
    console.error('spike-2-echo: FAILED to append to local log', err);
  }
  console.log(line);
}

function makeQuietLogger(): SocketFactoryLogger {
  const noop = (): void => undefined;
  const self: SocketFactoryLogger = {
    level: 'warn',
    child: () => self,
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
  };
  return self;
}

async function pairStage(): Promise<void> {
  console.log(
    [
      '=== SPIKE-2 stage: pair ===',
      '1. This opens a real Baileys socket using the pinned P08 config.',
      '2. A QR code prints to THIS terminal (never logged to file - pairing payloads never touch the raw log).',
      "3. Scan it with the SECOND real phone (never the founder's primary number).",
      '4. Wait for "connection.update: open" below, then Ctrl+C - creds are saved to .local/auth-state/.',
    ].join('\n'),
  );
  ensureLogDir();
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const logger = makeQuietLogger();
  const sock = createBaileysSocket({ auth: state, logger, getMessage: async () => undefined });
  sock.ev.on('creds.update', () => {
    void saveCreds();
  });
  sock.ev.on('connection.update', (update) => {
    logLine({ stage: 'pair', event: 'connection.update', connection: update.connection ?? null });
    if (update.qr !== undefined) {
      console.log('\n--- SCAN THIS QR (second real phone) ---\n');
    }
    if (update.connection === 'open') {
      console.log('\nPAIRED. Creds saved. Ctrl+C now, then run the "trial" stage.\n');
    }
  });
}

async function trialStage(
  trialArg: string | undefined,
  bucketArg: string | undefined,
): Promise<void> {
  const trialNo = trialArg !== undefined ? Number(trialArg) : NaN;
  const bucket = bucketArg;
  if (!Number.isInteger(trialNo) || bucket === undefined || !(bucket in OFFLINE_BUCKET_MS)) {
    console.error('Usage: tsx spike-2-echo.ts trial <n> <30s|5m|10m>');
    process.exitCode = 1;
    return;
  }
  const offlineMs = OFFLINE_BUCKET_MS[bucket];

  console.log(
    [
      `=== SPIKE-2 trial ${String(trialNo)} (offline bucket: ${bucket}) ===`,
      'This stage assumes "pair" already ran and .local/auth-state/ has real creds.',
      'STEPS the operator performs, IN ORDER:',
      '  1. When this process prints "SOCKET OPEN", manually send ONE message from the',
      '     linked device to any real recipient (phone UI or your own send path - either',
      '     is fine, this spike only needs a real fromMe send).',
      '  2. Note the message text/recipient yourself (off this tool) to compare a hash later.',
      '  3. Then hard-kill this process: `taskkill /F /PID <pid>` on Windows (Ctrl+C is NOT',
      '     a hard kill and will not reproduce a crash-mid-send).',
      `  4. Wait exactly the offline bucket (${bucket} = ${String(offlineMs)}ms) with the process dead.`,
      '  5. Re-run this exact command to reconnect and start the 15-minute observation window.',
      `     PID of this process: ${String(process.pid)}`,
    ].join('\n'),
  );

  logLine({ stage: 'trial-start', trialNo, bucket, offlineMs });
  await observe(trialNo, bucket);
}

async function observe(trialNo: number, bucket: string): Promise<void> {
  ensureLogDir();
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const logger = makeQuietLogger();
  const sock = createBaileysSocket({ auth: state, logger, getMessage: async () => undefined });
  sock.ev.on('creds.update', () => {
    void saveCreds();
  });

  const reconnectedAt = Date.now();
  let echoFound = false;

  for (const eventName of ALL_BAILEYS_EVENTS) {
    sock.ev.on(eventName, (payload: unknown) => {
      handleRawEvent(trialNo, bucket, eventName, payload, reconnectedAt, () => {
        echoFound = true;
      });
    });
  }

  sock.ev.on('connection.update', (update) => {
    if (update.connection === 'open') {
      console.log(
        `SOCKET OPEN. PID ${String(process.pid)}. Window ${String(OBSERVATION_WINDOW_MS)}ms.`,
      );
    }
  });

  await new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, OBSERVATION_WINDOW_MS);
  });

  logLine({
    stage: 'trial-end',
    trialNo,
    bucket,
    echoFoundWithinWindow: echoFound,
    windowMs: OBSERVATION_WINDOW_MS,
  });
  const foundMsg = `Trial ${String(trialNo)}: echo observed within the window - see raw log for event/latency.`;
  const missMsg = `Trial ${String(trialNo)}: NO echo within ${String(OBSERVATION_WINDOW_MS)}ms - record as a genuine miss ONLY if the socket stayed open the whole window (check the log for connection.update closes), else INCOMPLETE.`;
  console.log(echoFound ? foundMsg : missMsg);
  process.exit(0);
}

function handleRawEvent(
  trialNo: number,
  bucket: string,
  eventName: string,
  payload: unknown,
  reconnectedAt: number,
  onEcho: () => void,
): void {
  if (eventName === 'messages.upsert') {
    const upsert = payload as { messages: WAMessage[]; type: 'notify' | 'append' };
    for (const wa of upsert.messages) {
      if (wa.key.fromMe !== true) continue;
      onEcho();
      logEcho(trialNo, bucket, 'messages.upsert', upsert.type, wa, reconnectedAt);
    }
    return;
  }
  if (eventName === 'messaging-history.set') {
    const historySet = payload as { messages: WAMessage[] };
    for (const wa of historySet.messages) {
      if (wa.key.fromMe !== true) continue;
      onEcho();
      logEcho(trialNo, bucket, 'messaging-history.set', null, wa, reconnectedAt);
    }
    return;
  }
  // Every other event: NAME + shape only (never a body/JID verbatim) - so an unanticipated path is still visible.
  logLine({ stage: 'raw-event', trialNo, bucket, event: eventName, shape: shapeOf(payload) });
}

function logEcho(
  trialNo: number,
  bucket: string,
  event: 'messages.upsert' | 'messaging-history.set',
  upsertType: 'notify' | 'append' | null,
  wa: WAMessage,
  reconnectedAt: number,
): void {
  const latencyMs = Date.now() - reconnectedAt;
  const fields = echoContentHashFields(wa);
  const echoHash = fields !== undefined ? computeContentHash(fields).toString('hex') : null;
  const { kind, text } = deriveKindAndText(wa.message ?? undefined);

  logLine({
    stage: 'echo-observed',
    trialNo,
    bucket,
    event,
    upsertType,
    latencyMs,
    key: redactKey(wa.key),
    kind,
    text: redactText(text ?? null),
    hasDeviceSentMessage: wa.message?.deviceSentMessage !== undefined,
    destinationJid: redactJid(wa.message?.deviceSentMessage?.destinationJid),
    // hex digest is opaque, not PII - safe to log for a by-hand dispatch-side comparison.
    echoContentHashHex: echoHash,
    hashComputable: fields !== undefined,
  });
}

async function main(): Promise<void> {
  const [, , stage, arg1, arg2] = process.argv;
  if (stage === 'pair') {
    await pairStage();
    return;
  }
  if (stage === 'trial') {
    await trialStage(arg1, arg2);
    return;
  }
  if (stage === 'observe') {
    const trialNo = arg1 !== undefined ? Number(arg1) : NaN;
    if (!Number.isInteger(trialNo)) {
      console.error('Usage: tsx spike-2-echo.ts observe <n>');
      process.exitCode = 1;
      return;
    }
    await observe(trialNo, '(observe-only)');
    return;
  }
  console.log(
    [
      'SPIKE-2 echo runner - human-operated, not an automated test. Stages:',
      '  pair                    - link a SECOND real phone, save creds locally',
      '  trial <n> <30s|5m|10m>  - staged instructions + 15-min observation for trial n',
      '  observe <n>             - resume observing (no new staged instructions) for trial n',
    ].join('\n'),
  );
}

void main();
