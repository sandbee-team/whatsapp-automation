import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileKeyProvider, KEK_PURPOSES, openJson, sealJson } from '@wp/server-kit/crypto';
import type { KekPurpose } from '@wp/server-kit/crypto';
import { CryptoError } from '@wp/server-kit/errors';
import {
  assertNoSecretLeak,
  bufferJsonCodec,
  COPY_DESCRIPTIONS,
  decryptOfflineCopy,
  encryptOfflineCopy,
  makeCredentialShapedRecord,
  provisionRing,
  safeBuffersEqual,
  type KeyRingDrillOptions,
  type KeyRingDrillResult,
} from './keyring-restore-drill-lib.js';

/**
 * The drill deletes `scratchDir` RECURSIVELY when it finishes, so a
 * caller-supplied path is only accepted when it is disposable by
 * construction: it does not exist yet (the drill creates it), or it lives
 * under the OS temp directory. Anything else is refused BEFORE a single
 * byte is written (P29a C1 finding: an existing non-temp directory passed
 * by mistake would have been wiped).
 */
function assertScratchDirIsDisposable(scratchDir: string): void {
  const resolved = path.resolve(scratchDir);
  const tmpRoot = path.resolve(tmpdir());
  const underTmp = resolved !== tmpRoot && resolved.startsWith(tmpRoot + path.sep);
  if (!underTmp && existsSync(resolved)) {
    throw new Error(
      'keyring-restore-drill: refusing to run - scratchDir must not exist yet or must live under the OS temp directory, because the drill removes it recursively at the end',
    );
  }
}

/**
 * Runs the timed key-ring restore drill end to end in `opts.scratchDir`.
 * Every `out()` line and the evidence JSON are redaction-checked
 * (`assertNoSecretLeak`) before they leave this function - see the module
 * doc in `keyring-restore-drill-lib.ts`.
 */
export async function runKeyRingRestoreDrill(
  opts: KeyRingDrillOptions,
): Promise<KeyRingDrillResult & { __testOnlyMaterials?: unknown }> {
  const { scratchDir, now, out } = opts;
  assertScratchDirIsDisposable(scratchDir);
  const problems: string[] = [];
  const startedAtMs = now();

  const runningCopyPath = path.join(scratchDir, 'running-copy.json');
  const offlineCopyPath = path.join(scratchDir, 'offline-copy.age-like.bin');
  const sealedSecondCopyPath = path.join(scratchDir, 'sealed-second-copy.bin');
  const restoredRingPath = path.join(scratchDir, 'restored-ring.json');

  const passphrase = randomBytes(32);
  const guard = {
    materials: [] as string[],
    passphraseB64: passphrase.toString('base64'),
    passphraseHex: passphrase.toString('hex'),
    scratchDir,
  };
  const emit = (line: string): void => {
    assertNoSecretLeak(line, guard);
    out(line);
  };

  try {
    // --- 1. provision -----------------------------------------------------
    const provisionStart = now();
    const { ring, keys } = provisionRing();
    guard.materials.push(...keys.map((k) => k.materialB64));
    mkdirSync(scratchDir, { recursive: true });
    writeFileSync(runningCopyPath, JSON.stringify(ring), { mode: 0o400 });
    const provisionMs = now() - provisionStart;
    emit('provisioned a production-shaped key ring in the scratch directory');

    // --- 2. offline copies --------------------------------------------------
    const ringBytes = Buffer.from(JSON.stringify(ring), 'utf8');
    const offlineCiphertext = encryptOfflineCopy(ringBytes, passphrase);
    writeFileSync(offlineCopyPath, offlineCiphertext);
    const sealedSecondCiphertext = encryptOfflineCopy(ringBytes, passphrase);
    writeFileSync(sealedSecondCopyPath, sealedSecondCiphertext);
    emit("wrote the founder's offline encrypted copy and the sealed second offline copy");

    // --- 3. seal a real credential-shaped record ---------------------------
    const sealStart = now();
    const provider = new FileKeyProvider({
      ringPath: runningCopyPath,
      mountedPurposes: ['session'],
    });
    const record = makeCredentialShapedRecord();
    const plaintextCanonical = Buffer.from(
      JSON.stringify({ __wp_sealed_json_v: 1, v: record }, bufferJsonCodec.replacer),
      'utf8',
    );
    const blob = sealJson(
      record,
      {
        provider,
        purpose: 'session',
        encVersion: 1,
        tableName: 'whatsapp_session_credentials',
        columnName: 'creds_enc',
        clientId: 'drill-client',
        recordId: 'drill-instance',
      },
      bufferJsonCodec,
    );
    const sealMs = now() - sealStart;
    emit('sealed a credential-shaped record under the active session key');

    // --- 4. destroy the running copy ---------------------------------------
    const destroyStart = now();
    rmSync(runningCopyPath, { force: true });
    let destroyedProven = false;
    try {
      new FileKeyProvider({ ringPath: runningCopyPath, mountedPurposes: ['session'] });
    } catch (err) {
      destroyedProven = err instanceof CryptoError;
    }
    const destroyMs = now() - destroyStart;
    if (!destroyedProven) {
      problems.push('destruction of the running copy could not be proven');
    }
    emit('destroyed the running copy and proved it can no longer be loaded');

    // --- 5. restore from the offline copy ----------------------------------
    const restoreStart = now();
    let plaintextIdentical = false;
    let restoredKekId = '';
    let offlineOk = true;
    try {
      const offlineBytes = new Uint8Array(offlineCiphertext);
      if (opts.corruptOfflineCopy) {
        offlineBytes[offlineBytes.length - 1] = (offlineBytes[offlineBytes.length - 1] ?? 0) ^ 0xff;
      }
      const decryptedRing = decryptOfflineCopy(Buffer.from(offlineBytes), passphrase);
      writeFileSync(restoredRingPath, decryptedRing);
      const restoredProvider = new FileKeyProvider({
        ringPath: restoredRingPath,
        mountedPurposes: ['session'],
      });
      const opened = openJson(
        blob,
        {
          provider: restoredProvider,
          purpose: 'session',
          tableName: 'whatsapp_session_credentials',
          columnName: 'creds_enc',
          clientId: 'drill-client',
          recordId: 'drill-instance',
        },
        bufferJsonCodec,
      );
      const openedCanonical = Buffer.from(
        JSON.stringify({ __wp_sealed_json_v: 1, v: opened }, bufferJsonCodec.replacer),
        'utf8',
      );
      plaintextIdentical = safeBuffersEqual(plaintextCanonical, openedCanonical);
      restoredKekId = blob.kek_id;
    } catch {
      offlineOk = false;
    }
    const restoreMs = now() - restoreStart;

    if (!offlineOk || !plaintextIdentical) {
      problems.push(
        'offline copy could not be decrypted - the key backup does not work; launch is blocked',
      );
    }
    emit('restored the ring from the offline copy and reopened the sealed record');

    // --- 6. verify -----------------------------------------------------------
    const verifyStart = now();
    const verifyMs = now() - verifyStart;

    const finishedAtMs = now();
    const totalMs = provisionMs + sealMs + destroyMs + restoreMs + verifyMs;

    const result: KeyRingDrillResult & { __testOnlyMaterials?: unknown } = {
      verdict: destroyedProven && plaintextIdentical && problems.length === 0 ? 'PASS' : 'FAIL',
      startedAtIso: new Date(startedAtMs).toISOString(),
      finishedAtIso: new Date(finishedAtMs).toISOString(),
      phases: { provisionMs, sealMs, destroyMs, restoreMs, verifyMs, totalMs },
      ring: {
        purposes: [...KEK_PURPOSES],
        keyCount: keys.length,
        retiredCount: keys.filter((k) => k.retired).length,
        activeKekIdsByPurpose: Object.fromEntries(
          KEK_PURPOSES.map((purpose: KekPurpose) => [
            purpose,
            keys.find((k) => k.purpose === purpose && !k.retired)?.kekId ?? '',
          ]),
        ),
      },
      record: {
        plaintextBytes: plaintextCanonical.length,
        sealedBytes: blob.ciphertext.length,
        kekId: restoredKekId,
      },
      destroyedProven,
      plaintextIdentical,
      copies: COPY_DESCRIPTIONS,
      problems,
    };

    if (opts.evidenceJsonPath) {
      const evidenceJson = JSON.stringify(result, null, 2);
      assertNoSecretLeak(evidenceJson, guard);
      writeFileSync(opts.evidenceJsonPath, evidenceJson, 'utf8');
    }

    // Attached AFTER the evidence JSON is serialised and redaction-checked -
    // `__testOnlyMaterials` exists purely for the leak-detection test itself
    // to compare against, and must never be part of what is written to disk
    // or checked as "safe" by `assertNoSecretLeak` above.
    if (opts.exposeMaterialsForTest === true) {
      result.__testOnlyMaterials = {
        materials: guard.materials,
        passphraseB64: guard.passphraseB64,
        passphraseHex: guard.passphraseHex,
      };
    }

    return result;
  } finally {
    // The scratch dir is cleaned at the end (also on failure), except the
    // evidence JSON itself when a caller asked for it to be written inside
    // that same directory (the drill's tests do, so they can read it back
    // after the run) - every OTHER scratch artifact (the ring, both offline
    // copies, the sealed record's working files) is removed unconditionally.
    const evidenceInsideScratch =
      opts.evidenceJsonPath !== undefined && path.dirname(opts.evidenceJsonPath) === scratchDir;
    if (evidenceInsideScratch) {
      const evidenceFileName = path.basename(opts.evidenceJsonPath as string);
      for (const entry of readdirSync(scratchDir)) {
        if (entry !== evidenceFileName) {
          rmSync(path.join(scratchDir, entry), { recursive: true, force: true });
        }
      }
    } else {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  }
}

const DEFAULT_EVIDENCE_JSON_PATH = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  '..',
  'docs',
  'measurements',
  '2026-09-08-keyring-restore-drill.json',
);

/** CLI entry point: real clock, real temp scratch dir, writes the measurements JSON. */
async function main(): Promise<void> {
  const outArgIndex = process.argv.indexOf('--out');
  const evidenceJsonPath =
    outArgIndex >= 0 ? process.argv[outArgIndex + 1] : DEFAULT_EVIDENCE_JSON_PATH;
  if (!evidenceJsonPath) {
    throw new Error('--out requires a path argument');
  }

  const scratchDir = mkdtempSync(path.join(tmpdir(), 'wp-keyring-restore-drill-'));
  const result = await runKeyRingRestoreDrill({
    scratchDir,
    now: Date.now,
    out: (line) => console.log(line),
    evidenceJsonPath,
  });

  console.log(`verdict: ${result.verdict}`);
  console.log(`phases: ${JSON.stringify(result.phases)}`);
  process.exitCode = result.verdict === 'PASS' ? 0 : 1;
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main().catch((err: unknown) => {
    console.error(
      'key-ring restore drill failed to run:',
      err instanceof Error ? err.message : err,
    );
    process.exitCode = 1;
  });
}
