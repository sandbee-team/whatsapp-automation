import { hash, verify, type Algorithm } from '@node-rs/argon2';

/**
 * `@node-rs/argon2` declares `Algorithm` as an ambient `const enum`, which
 * `verbatimModuleSyntax` (packages/config/tsconfig.base.json) forbids
 * VALUE access to (TS2748) - only its TYPE may be imported. `2` is
 * `Algorithm.Argon2id` per that enum's own declaration; asserted as
 * `Algorithm` so `Options.algorithm` stays fully typed at the call site.
 */
const ARGON2ID = 2 as Algorithm;

/**
 * password.ts (P04a Unit A4) - pure argon2id hashing port. NEVER reads
 * `process.env`/`config` directly (core rule: config only lives in
 * `platform/config.ts`) - callers pass an `Argon2Params` explicitly, which
 * lets tests inject a cheap profile while production wiring passes the
 * canon OWASP-baseline defaults (`ARGON2_MEMORY_KIB`/`ARGON2_TIME_COST`/
 * `ARGON2_PARALLELISM` in `platform/config.ts`: 19456 KiB, time cost 2,
 * parallelism 1) - never the other way around.
 */

export interface Argon2Params {
  /** Memory cost in KiB (library option name: `memoryCost`). */
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

/** PHC-format argon2id hash: `$argon2id$v=19$m=<mem>,t=<time>,p=<par>$<salt>$<hash>`. */
const HASH_PARAM_PATTERN = /\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/;

/** Hashes `plain` with argon2id under `params`. Salt is generated internally by @node-rs/argon2. */
export async function hashPassword(plain: string, params: Argon2Params): Promise<string> {
  return hash(plain, {
    algorithm: ARGON2ID,
    memoryCost: params.memoryCost,
    timeCost: params.timeCost,
    parallelism: params.parallelism,
  });
}

/** Verifies `plain` against an existing PHC-format `hashed` value (its own embedded params are used). */
export async function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  return verify(hashed, plain);
}

/**
 * True when `hashed` was produced with weaker/different cost parameters than
 * `params` (or is unparseable, which fails safe toward "needs rehash" rather
 * than silently trusting an unexpected format). Drives rehash-on-login
 * (login.service.ts): a successful login with a stale hash re-hashes and
 * persists the new value under current params.
 */
export function needsRehash(hashed: string, params: Argon2Params): boolean {
  const match = HASH_PARAM_PATTERN.exec(hashed);
  if (!match) {
    return true;
  }
  const [, memoryCost, timeCost, parallelism] = match;
  return (
    Number(memoryCost) !== params.memoryCost ||
    Number(timeCost) !== params.timeCost ||
    Number(parallelism) !== params.parallelism
  );
}
