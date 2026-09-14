import { configSchema, type Config } from './schema.js';

export { KEK_PURPOSES, type KekPurpose } from './schema.js';
export type { Config } from './schema.js';

/**
 * @wp/server-kit/config - Zod-parsed frozen config loaded once at boot, the
 * single `process.env` reader in this package. Nothing else in
 * `@wp/server-kit` may read `process.env` directly - every other module
 * imports `config` from here.
 *
 * "Parsed once": this module-level `parse()` call runs a single time, the
 * first time this module is imported. `process.env` is captured at that
 * moment; later mutations to `process.env` are never observed. "Frozen":
 * the result (including the nested `WP_KEK_PURPOSES` array) is deep-frozen
 * with `Object.freeze`, so any attempted mutation throws in strict mode.
 *
 * On invalid/missing input, `parse()` throws a `ConfigError` that names the
 * offending key(s) and nothing else - it never echoes a value, because some
 * of these values are secrets (e.g. `WP_KEY_RING_PATH`).
 */
function parse(): Config {
  const result = configSchema.safeParse(process.env);

  if (!result.success) {
    const keys = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))];
    throw new ConfigError(keys);
  }

  return Object.freeze({
    ...result.data,
    WP_KEK_PURPOSES: Object.freeze([...result.data.WP_KEK_PURPOSES]),
  });
}

/** Thrown by the config loader; names the offending env var keys only. */
export class ConfigError extends Error {
  readonly keys: readonly string[];

  constructor(keys: readonly string[]) {
    super(`Invalid or missing config env var(s): ${keys.join(', ')}`);
    this.name = 'ConfigError';
    this.keys = keys;
  }
}

export const config: Readonly<Config> = parse();
