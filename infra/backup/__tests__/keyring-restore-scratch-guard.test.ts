import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runKeyRingRestoreDrill } from '../keyring-restore-drill.js';

/**
 * keyring-restore-scratch-guard.test.ts (P29a C1 finding, 2026-09-09) - the
 * drill removes its scratch directory recursively, so a caller-supplied path
 * that already exists OUTSIDE the OS temp dir must be refused before any
 * write. The refusal is proven on a real, non-temp directory (a sibling of
 * this test file) that must survive untouched.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('key-ring drill scratch-directory guard', () => {
  it('an_existing_directory_outside_the_temp_root_is_refused_before_any_write', async () => {
    const victim = path.join(HERE, `.scratch-guard-victim-${String(process.pid)}`);
    rmSync(victim, { recursive: true, force: true });
    // An EXISTING non-temp dir with one file the drill must not touch.
    mkdirSync(victim, { recursive: true });
    const sentinelPath = path.join(victim, 'do-not-delete.txt');
    writeFileSync(sentinelPath, 'sentinel');
    created.push(victim);

    const lines: string[] = [];
    await expect(
      runKeyRingRestoreDrill({ scratchDir: victim, now: () => 0, out: (l) => lines.push(l) }),
    ).rejects.toThrow(/refusing to run/);

    expect(lines).toEqual([]);
    expect(existsSync(sentinelPath)).toBe(true);
    expect(readdirSync(victim)).toEqual(['do-not-delete.txt']);
  });

  it('a_directory_under_the_os_temp_root_is_accepted_and_cleaned', async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'wp-keyring-guard-ok-'));
    let tick = 0;
    const result = await runKeyRingRestoreDrill({
      scratchDir: scratch,
      now: () => (tick += 10),
      out: () => undefined,
    });
    expect(result.verdict).toBe('PASS');
    expect(existsSync(scratch)).toBe(false);
  });
});
