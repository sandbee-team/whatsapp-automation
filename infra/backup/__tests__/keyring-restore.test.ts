import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KEK_PURPOSES } from '@wp/server-kit/crypto';
import { runKeyRingRestoreDrill } from '../keyring-restore-drill.js';
import type { KeyRingDrillResult } from '../keyring-restore-drill-lib.js';

/** Every scratch dir created by a test, cleaned up even on assertion failure. */
const scratchDirs: string[] = [];

function makeScratchDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'wp-keyring-drill-test-'));
  scratchDirs.push(dir);
  return dir;
}

/** Injected clock: ticks +250 ms on every call, deterministic across runs. */
function makeTickingClock(startMs: number, stepMs: number): () => number {
  let current = startMs - stepMs;
  return () => {
    current += stepMs;
    return current;
  };
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

/** Recursively walks a JSON value, calling `visit` on every string found. */
function walkStrings(value: unknown, visit: (s: string) => void): void {
  if (typeof value === 'string') {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      walkStrings(item, visit);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (key === 'material') {
        throw new Error(`evidence JSON must never have a "material" key, found one`);
      }
      walkStrings(v, visit);
    }
  }
}

/** True if `s` decodes as base64 to exactly 32 bytes (the material length). */
function isThirtyTwoByteBase64(s: string): boolean {
  if (!/^[A-Za-z0-9+/]+=*$/.test(s) || s.length < 40) {
    return false;
  }
  try {
    const decoded = Buffer.from(s, 'base64');
    return decoded.length === 32 && decoded.toString('base64') === s;
  } catch {
    return false;
  }
}

describe('the key-ring restore drill', () => {
  it('a_sealed_record_opens_after_restoring_the_offline_key_ring_copy', async () => {
    const scratchDir = makeScratchDir();
    const clock = makeTickingClock(1_000, 250);
    const lines: string[] = [];

    const result = await runKeyRingRestoreDrill({
      scratchDir,
      now: clock,
      out: (line) => lines.push(line),
    });

    expect(result.verdict).toBe('PASS');
    expect(result.plaintextIdentical).toBe(true);
    expect(result.destroyedProven).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.ring.purposes).toEqual([...KEK_PURPOSES]);
    expect(result.ring.keyCount).toBe(KEK_PURPOSES.length + 1);
    expect(result.ring.retiredCount).toBe(1);
    expect(result.copies).toEqual([
      'host secret store (running copy)',
      "founder's offline encrypted copy",
      'sealed second offline copy',
    ]);

    // 8 timed phase boundaries at +250ms each: provision, seal, destroy,
    // restore, verify each consume one clock tick pair (start/end) - the
    // exact total is derived from the injected clock, not asserted as a
    // bound.
    expect(result.phases.totalMs).toBe(
      result.phases.provisionMs +
        result.phases.sealMs +
        result.phases.destroyMs +
        result.phases.restoreMs +
        result.phases.verifyMs,
    );
    expect(result.phases.totalMs).toBeGreaterThan(0);
  });

  it('the_drill_never_prints_or_persists_key_material', async () => {
    const scratchDir = makeScratchDir();
    const clock = makeTickingClock(2_000, 250);
    const lines: string[] = [];
    const evidenceJsonPath = path.join(scratchDir, 'evidence-out.json');

    const result = (await runKeyRingRestoreDrill({
      scratchDir,
      now: clock,
      out: (line) => lines.push(line),
      evidenceJsonPath,
      exposeMaterialsForTest: true,
    })) as KeyRingDrillResult & {
      __testOnlyMaterials?: { materials: string[]; passphraseB64: string; passphraseHex: string };
    };

    expect(result.verdict).toBe('PASS');
    const secrets = result.__testOnlyMaterials;
    expect(secrets).toBeDefined();
    if (!secrets) {
      throw new Error('unreachable');
    }

    const evidenceText = readFileSync(evidenceJsonPath, 'utf8');
    const haystacks = [...lines, evidenceText];

    for (const haystack of haystacks) {
      for (const material of secrets.materials) {
        expect(haystack).not.toContain(material);
      }
      expect(haystack).not.toContain(secrets.passphraseB64);
      expect(haystack).not.toContain(secrets.passphraseHex);
      expect(haystack).not.toContain(scratchDir);
    }

    const evidenceParsed: unknown = JSON.parse(evidenceText);
    walkStrings(evidenceParsed, (s) => {
      expect(isThirtyTwoByteBase64(s)).toBe(false);
    });
  });

  it('a_corrupted_offline_copy_is_an_honest_fail_not_a_workaround', async () => {
    const scratchDir = makeScratchDir();
    const clock = makeTickingClock(3_000, 250);
    const lines: string[] = [];

    const result = await runKeyRingRestoreDrill({
      scratchDir,
      now: clock,
      out: (line) => lines.push(line),
      corruptOfflineCopy: true,
    });

    expect(result.verdict).toBe('FAIL');
    expect(result.plaintextIdentical).toBe(false);
    expect(result.problems.length).toBeGreaterThan(0);
    expect(result.problems.some((p) => p.includes('key backup does not work'))).toBe(true);
    expect(result.problems.some((p) => p.includes('launch is blocked'))).toBe(true);
  });

  it('the_evidence_file_carries_timings_and_operator_by_description', () => {
    const mdText = readFileSync(
      path.resolve(process.cwd(), 'docs/evidence/P29-keyring-restore-drill.md'),
      'utf8',
    );
    const jsonText = readFileSync(
      path.resolve(process.cwd(), 'docs/measurements/2026-09-08-keyring-restore-drill.json'),
      'utf8',
    );

    expect(mdText).toContain('Measured duration');
    expect(mdText).toContain('Operator:');
    expect(mdText).toContain('host secret store (running copy)');
    expect(mdText).toContain("founder's offline encrypted copy");
    expect(mdText).toContain('sealed second offline copy');
    expect(mdText).toContain('2026-12-08');

    for (const text of [mdText, jsonText]) {
      expect(/[A-Za-z0-9+/]{43,44}=/.test(text)).toBe(false);
      expect(/^[A-Za-z]:\\/m.test(text)).toBe(false);
      expect(/\/tmp\//.test(text)).toBe(false);
      expect(/\/home\//.test(text)).toBe(false);
      expect(text.includes('AppData')).toBe(false);
    }
  });
});
