import path from 'node:path';
import fg from 'fast-glob';
import { resolveFiles } from './scan-config.js';
import { SEMGREP_GUARD_GLOBS } from './security-scan-guards-globs.js';

/**
 * security-scan-tar.ts (P29a semgrep-streaming perf fix) - a PURE ustar tar
 * writer plus the semgrep source-collection policy, split out of
 * `security-scan-lib.ts` to stay under its `max-lines: 300` cap (same
 * discipline as `security-scan-classify.ts`).
 *
 * WHY: on this Windows Docker Desktop box, bind-mounting the repo (`-v
 * <repo>:/src:ro`) makes every file read by semgrep slow - a full-tree scan
 * measured 1,228s wall clock under 1.5 min of actual CPU time (see
 * `docs/evidence/P29-security-scans.md`). Streaming the exact source set as
 * a tar archive on stdin (`docker run -i ... sh -c 'tar -xf - -C /src && ...'`)
 * avoids the mount entirely: the container's OWN filesystem receives the
 * files once, with no per-file round trip through the host bind mount.
 *
 * No Node builtins beyond `node:path`/`node:fs` - this stays a pure,
 * dependency-free tar implementation (no `tar`/`tar-stream` package) so the
 * CI critical path never depends on an extra third-party archiver.
 */

const BLOCK_SIZE = 512;
const NAME_MAX = 100;
const PREFIX_MAX = 155;

export interface TarEntryInput {
  path: string;
  content: Buffer;
  mode?: number;
}

function splitUstarPath(entryPath: string): { name: string; prefix: string } {
  if (entryPath.length <= NAME_MAX) {
    return { name: entryPath, prefix: '' };
  }
  // Find the leftmost '/' at or after the point where the tail (name) still
  // fits in NAME_MAX - the standard ustar split rule (this yields the
  // LONGEST valid name, and therefore the shortest possible prefix).
  const minSplitAt = entryPath.length - NAME_MAX;
  for (let splitAt = Math.max(minSplitAt, 1); splitAt <= entryPath.length; splitAt += 1) {
    if (entryPath[splitAt - 1] !== '/') continue;
    const prefix = entryPath.slice(0, splitAt - 1);
    const name = entryPath.slice(splitAt);
    if (prefix.length <= PREFIX_MAX && name.length <= NAME_MAX) {
      return { name, prefix };
    }
  }
  throw new Error(
    `security-scan-tar: path cannot be split into a ustar prefix (<=${String(PREFIX_MAX)}) ` +
      `and name (<=${String(NAME_MAX)}): ${entryPath}`,
  );
}

function writeOctalField(buf: Buffer, offset: number, length: number, value: number): void {
  // ustar octal fields are ASCII digits, NUL-terminated, left-padded with
  // '0', occupying `length` bytes total (last byte is the NUL terminator).
  const octal = value.toString(8).padStart(length - 1, '0');
  buf.write(octal, offset, length - 1, 'ascii');
  buf[offset + length - 1] = 0;
}

function writeStringField(buf: Buffer, offset: number, length: number, value: string): void {
  buf.write(value, offset, Math.min(value.length, length), 'ascii');
}

function buildHeader(name: string, prefix: string, size: number, mode: number): Buffer {
  const header = Buffer.alloc(BLOCK_SIZE, 0);
  writeStringField(header, 0, NAME_MAX, name);
  writeOctalField(header, 100, 8, mode);
  writeOctalField(header, 108, 8, 0); // uid
  writeOctalField(header, 116, 8, 0); // gid
  writeOctalField(header, 124, 12, size);
  writeOctalField(header, 136, 12, 0); // mtime
  header.fill(0x20, 148, 156); // checksum field: 8 spaces while computing
  header[156] = '0'.charCodeAt(0); // typeflag: regular file
  writeStringField(header, 257, 6, 'ustar'); // magic "ustar\0" (byte 262 stays NUL)
  writeStringField(header, 263, 2, '00'); // ustar version at 263-264 (POSIX; C1 re-review fix)
  writeStringField(header, 345, PREFIX_MAX, prefix);

  let checksum = 0;
  for (const byte of header) checksum += byte;
  // The checksum field itself is NOT a standard NUL-terminated octal field:
  // it is 6 octal digits, then a NUL, then a trailing space (POSIX ustar
  // spec) - written directly rather than via `writeOctalField`.
  const checksumOctal = checksum.toString(8).padStart(6, '0');
  header.write(checksumOctal, 148, 6, 'ascii');
  header[148 + 6] = 0;
  header[148 + 7] = 0x20;

  return header;
}

function padToBlock(buf: Buffer): Buffer {
  const remainder = buf.length % BLOCK_SIZE;
  if (remainder === 0) return buf;
  return Buffer.concat([buf, Buffer.alloc(BLOCK_SIZE - remainder, 0)]);
}

/**
 * Builds a POSIX ustar archive from in-memory entries: 512-byte header +
 * content blocks per entry, terminated by two all-zero blocks. Paths longer
 * than 100 bytes are split across the ustar `name`/`prefix` fields; a path
 * that cannot be split within `name<=100`/`prefix<=155` throws rather than
 * silently truncating (a truncated path inside the container would scan the
 * wrong file, or none).
 */
export function buildTarArchive(entries: TarEntryInput[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const posixPath = entry.path.split(path.sep).join('/');
    const { name, prefix } = splitUstarPath(posixPath);
    const mode = entry.mode ?? 0o644;
    parts.push(buildHeader(name, prefix, entry.content.length, mode));
    parts.push(padToBlock(entry.content));
  }
  parts.push(Buffer.alloc(BLOCK_SIZE * 2, 0));
  return Buffer.concat(parts);
}

const FORBIDDEN_PATH_SEGMENTS = [
  'node_modules',
  'dist',
  '.next',
  'website/out',
  '.secrets',
  'demo',
  '.memory',
  '.claude',
];

function isForbidden(relativePosixPath: string): boolean {
  return FORBIDDEN_PATH_SEGMENTS.some(
    (segment) =>
      relativePosixPath === segment ||
      relativePosixPath.startsWith(`${segment}/`) ||
      relativePosixPath.includes(`/${segment}/`),
  );
}

/**
 * The list of repo-relative (posix) source paths to ship into the semgrep
 * container, plus `.semgrep.yml` always present at the archive root.
 *
 * - Real repo-root scan (`scanRoot === repoRoot`): the same glob set the
 *   `security:semgrep` guard already resolves (`SEMGREP_GUARD_GLOBS`),
 *   which is exactly what the bind-mounted scan used to see minus the
 *   artefact/content exclusions `resolveFiles` already applies.
 * - Fixture scan (`scanRoot` is a directory INSIDE the repo, used by
 *   `each_scanner_fails_on_its_seeded_fixture`): every file under that
 *   directory, recursively - the fixture is small and self-contained, so no
 *   glob filtering is needed or wanted there.
 */
export function collectSemgrepSources(repoRoot: string, scanRoot: string): string[] {
  const relativeFiles =
    scanRoot === repoRoot
      ? resolveFiles(SEMGREP_GUARD_GLOBS)
      : resolveFilesUnderFixtureDir(repoRoot, scanRoot);

  const filtered = relativeFiles.filter((file) => !isForbidden(file));
  return ['.semgrep.yml', ...filtered];
}

function resolveFilesUnderFixtureDir(repoRoot: string, scanRoot: string): string[] {
  // Deliberately does not reuse `resolveFiles` (which is scoped to
  // `REPO_ROOT`-relative globs) - a fixture scan needs every file under an
  // arbitrary directory INSIDE the repo, addressed relative to `repoRoot`
  // so the returned paths are consistent with the repo-root case.
  const absoluteMatches = fg.sync('**/*', { cwd: scanRoot, onlyFiles: true, dot: false });
  return absoluteMatches.map((relativeToFixture) =>
    path.relative(repoRoot, path.join(scanRoot, relativeToFixture)).split(path.sep).join('/'),
  );
}
