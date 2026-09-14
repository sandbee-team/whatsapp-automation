import { describe, expect, it } from 'vitest';
import { buildTarArchive, collectSemgrepSources } from './security-scan-tar.js';
import { REPO_ROOT } from './scan-config.js';

/**
 * security-scan-tar.test.ts (P29a semgrep-streaming perf fix) - proves the
 * pure ustar tar writer round-trips names/sizes/content exactly (including
 * the ustar `prefix` split for paths > 100 chars and a 0-byte file), and
 * that `collectSemgrepSources` ships the ruleset plus real source files but
 * never build artefacts or secrets directories.
 */

const BLOCK_SIZE = 512;

interface ParsedTarEntry {
  name: string;
  size: number;
  content: Buffer;
}

function readOctal(buf: Buffer): number {
  const str = buf.toString('ascii').replace(/\0/g, '').trim();
  return str === '' ? 0 : parseInt(str, 8);
}

/** Minimal test-local ustar reader - independent of the writer under test. */
function parseTarArchive(archive: Buffer): ParsedTarEntry[] {
  const entries: ParsedTarEntry[] = [];
  let offset = 0;
  while (offset + BLOCK_SIZE <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const nameField = header.subarray(0, 100).toString('ascii').replace(/\0.*$/s, '');
    const size = readOctal(header.subarray(124, 136));
    const magic = header.subarray(257, 263).toString('ascii');
    const prefixField = header.subarray(345, 500).toString('ascii').replace(/\0.*$/s, '');
    if (!magic.startsWith('ustar')) {
      throw new Error(
        `bad ustar magic (byte position ${String(offset)}): ${JSON.stringify(magic)}`,
      );
    }
    const fullName = prefixField === '' ? nameField : `${prefixField}/${nameField}`;
    const contentStart = offset + BLOCK_SIZE;
    const content = archive.subarray(contentStart, contentStart + size);
    entries.push({ name: fullName, size, content: Buffer.from(content) });
    const paddedSize = Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
    offset = contentStart + paddedSize;
  }
  return entries;
}

describe('buildTarArchive', () => {
  it('the_tar_writer_round_trips_names_sizes_and_content', () => {
    const longPath =
      'app/backend/src/modules/notifications/dispatch/very/deeply/nested/directory/structure/for/testing/the/ustar/prefix/field/split/behaviour/long-file-name-past-100-chars.ts';
    expect(longPath.length).toBeGreaterThan(100);

    const entries = [
      { path: 'short.txt', content: Buffer.from('hello world', 'utf8') },
      { path: 'empty.txt', content: Buffer.alloc(0) },
      { path: longPath, content: Buffer.from('export const x = 1;', 'utf8') },
    ];

    const archive = buildTarArchive(entries);

    // Archive length must be a multiple of the 512-byte block size, and end
    // with two all-zero blocks (the ustar end-of-archive marker).
    expect(archive.length % BLOCK_SIZE).toBe(0);
    const trailer = archive.subarray(archive.length - 2 * BLOCK_SIZE);
    expect(trailer.every((byte) => byte === 0)).toBe(true);

    const parsed = parseTarArchive(archive);
    expect(parsed).toHaveLength(3);

    const short = parsed.find((e) => e.name === 'short.txt');
    expect(short?.size).toBe(11);
    expect(short?.content.toString('utf8')).toBe('hello world');

    const empty = parsed.find((e) => e.name === 'empty.txt');
    expect(empty?.size).toBe(0);
    expect(empty?.content.length).toBe(0);

    const long = parsed.find((e) => e.name === longPath);
    expect(long?.size).toBe(19);
    expect(long?.content.toString('utf8')).toBe('export const x = 1;');
  });

  it('throws_when_a_path_cannot_be_split_into_a_valid_ustar_prefix_and_name', () => {
    const unsplittable = `${'a'.repeat(90)}/${'b'.repeat(120)}`;
    expect(() => buildTarArchive([{ path: unsplittable, content: Buffer.from('x') }])).toThrow();
  });
});

describe('collectSemgrepSources', () => {
  it('the_semgrep_archive_ships_the_ruleset_and_sources_but_never_artefacts_or_secrets', () => {
    const files = collectSemgrepSources(REPO_ROOT, REPO_ROOT);

    expect(files).toContain('.semgrep.yml');
    expect(files).toContain('scripts/guards/security-scan-lib.ts');
    // C1 re-review: infra/ and docs/ production TS must be in the scan set.
    expect(files).toContain('infra/backup/restore-drill.ts');
    expect(files).toContain('docs/__tests__/launch-checklist-parser.ts');
    // C1 re-review round 2: every production source tree the original
    // bind-mount scan covered must still be shipped - one representative
    // file per tree that a hand-listed glob set once missed.
    expect(files).toContain('packages/ui/src/button.tsx');
    expect(files).toContain('db/schema/message-jobs.ts');
    expect(files).toContain('website/next.config.mjs');
    expect(files).toContain('app/backend/src/roles/api.ts');
    // dot-directories and the designated secret store are never shipped.
    expect(files.some((f) => /^(\.claude|\.secrets|\.data|\.turbo)\//.test(f))).toBe(false);
    expect(files.length).toBeGreaterThan(1000);

    const forbidden = /(^|\/)(node_modules|dist|\.next|out|\.secrets|demo|\.memory|\.claude)\//;
    for (const file of files) {
      expect(file, `file "${file}" matched a forbidden path segment`).not.toMatch(forbidden);
    }
  });
});
