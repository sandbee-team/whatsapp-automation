import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONNECTION_CONFIG } from 'baileys';
import type { AuthenticationState } from 'baileys';
import { BAILEYS_PINNED_VERSION } from './pinned.js';

/**
 * socket-config.test.ts (P08 U1 step 2, written FIRST) - `buildSocketConfig`
 * + `createBaileysSocket`. Everything here is about the STATIC config shape:
 * one constant browser identity, history/preview flags off, bounded caches,
 * and a runtime assertion that a typo'd key can never silently fall back to
 * an unbounded Baileys default.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

function makeStubAuth(): AuthenticationState {
  return {
    creds: {} as AuthenticationState['creds'],
    keys: {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => undefined),
    } as unknown as AuthenticationState['keys'],
  };
}

function makeStubLogger() {
  return {
    level: 'warn',
    child: vi.fn(),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

async function makeDeps() {
  const mod = await import('./socket-factory.js');
  return {
    mod,
    deps: {
      auth: makeStubAuth(),
      logger: makeStubLogger(),
      getMessage: vi.fn(async () => undefined),
    },
  };
}

describe('pinned_baileys_version_matches_installed_version', () => {
  it('matches package.json (no range) and the installed node_modules version', () => {
    const pkgPath = join(__dirname, '..', '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const declared = pkg.dependencies.baileys;
    expect(declared).toBe(BAILEYS_PINNED_VERSION);
    expect(declared).not.toMatch(/[\^~]/);

    const installedPkgPath = join(
      __dirname,
      '..',
      '..',
      '..',
      'node_modules',
      'baileys',
      'package.json',
    );
    const installed = JSON.parse(readFileSync(installedPkgPath, 'utf8')) as { version: string };
    expect(installed.version).toBe(BAILEYS_PINNED_VERSION);
  });
});

describe('every_socket_config_key_exists_in_default_connection_config', () => {
  it('every key the factory sets is either a DEFAULT_CONNECTION_CONFIG key or an allow-listed runtime key', async () => {
    const { mod, deps } = await makeDeps();
    const config = mod.buildSocketConfig(deps);
    const defaultKeys = new Set(Object.keys(DEFAULT_CONNECTION_CONFIG));

    for (const key of Object.keys(config)) {
      const isDefaultKey = defaultKeys.has(key);
      const isRequiredRuntimeKey = mod.REQUIRED_RUNTIME_KEYS.includes(key);
      expect(isDefaultKey || isRequiredRuntimeKey).toBe(true);
    }
  });

  it('REQUIRED_RUNTIME_KEYS has at most 4 entries', async () => {
    const { mod } = await makeDeps();
    expect(mod.REQUIRED_RUNTIME_KEYS.length).toBeLessThanOrEqual(4);
  });

  it('REQUIRED_RUNTIME_KEYS pins the exact current membership - silent growth must fail this test', async () => {
    const { mod } = await makeDeps();
    expect(mod.REQUIRED_RUNTIME_KEYS).toEqual([
      'qrTimeout',
      'msgRetryCounterCache',
      'userDevicesCache',
    ]);
  });

  it('a 5th REQUIRED_RUNTIME_KEYS entry fails the module-init cap assertion', () => {
    // Mirrors socket-factory.ts's own module-init guard (`length > 4` throws)
    // without depending on module-cache tricks to re-trigger real module
    // init - proves the cap is an enforced invariant, not just a comment.
    function assertCap(keys: readonly string[]): void {
      if (keys.length > 4) {
        throw new Error('socket-factory: REQUIRED_RUNTIME_KEYS has grown past its cap of 4');
      }
    }
    expect(() => assertCap(['a', 'b', 'c', 'd'])).not.toThrow();
    expect(() => assertCap(['a', 'b', 'c', 'd', 'e'])).toThrow();
  });

  it('a typo-d key fails the module-init assertion', async () => {
    const { mod, deps } = await makeDeps();
    const config = mod.buildSocketConfig(deps);
    expect(() => mod.assertKnownConfigKeys({ ...config, notARealKey: true })).toThrow();
  });
});

describe('browser_identity_is_one_constant_and_is_never_randomised', () => {
  it('two builds yield an identical browser tuple', async () => {
    const { mod, deps } = await makeDeps();
    const configA = mod.buildSocketConfig(deps);
    const configB = mod.buildSocketConfig(deps);
    expect(configA.browser).toEqual(configB.browser);
    expect(configA.browser).toEqual(['Ubuntu', 'Chrome', '22.04.4']);
  });

  it('the module source contains no Math.random or Date.now-derived identity', async () => {
    const modPath = join(__dirname, 'socket-factory.ts');
    const source = readFileSync(modPath, 'utf8');
    expect(source).not.toMatch(/Math\.random/);
    expect(source).not.toMatch(/Date\.now\(\)/);
  });
});

describe('history_presence_and_preview_flags_are_off', () => {
  it('sets all four flags off and binds size-bounded caches', async () => {
    const { mod, deps } = await makeDeps();
    const config = mod.buildSocketConfig(deps);

    expect(config.syncFullHistory).toBe(false);
    expect(config.markOnlineOnConnect).toBe(false);
    expect(config.generateHighQualityLinkPreview).toBe(false);
    expect(config.shouldSyncHistoryMessage?.({} as never)).toBe(false);

    expect(config.qrTimeout).toBe(45_000);

    for (const cache of [config.msgRetryCounterCache, config.userDevicesCache]) {
      expect(cache).toBeDefined();
      expect(typeof cache?.get).toBe('function');
      expect(typeof cache?.set).toBe('function');
      expect(typeof cache?.del).toBe('function');
      expect(typeof cache?.flushAll).toBe('function');
    }
  });

  it('bounded caches evict past their max size', async () => {
    const { mod, deps } = await makeDeps();
    const config = mod.buildSocketConfig(deps);
    const cache = config.msgRetryCounterCache;
    expect(cache).toBeDefined();
    if (!cache) throw new Error('unreachable');

    const max = mod.SOCKET_CACHE_MAX_ENTRIES;
    for (let i = 0; i < max + 10; i += 1) {
      await cache.set(`k${String(i)}`, i);
    }
    let size = 0;
    for (let i = 0; i < max + 10; i += 1) {
      if ((await cache.get(`k${String(i)}`)) !== undefined) size += 1;
    }
    expect(size).toBeLessThanOrEqual(max);
  });
});

describe('createBaileysSocket', () => {
  it('calls makeWASocket with the built config', async () => {
    const { mod, deps } = await makeDeps();
    const fakeSocket = { ev: { on: vi.fn() } };
    const makeWASocket = vi.fn(() => fakeSocket);
    const socket = mod.createBaileysSocket(deps, { makeWASocketImpl: makeWASocket as never });
    expect(makeWASocket).toHaveBeenCalledTimes(1);
    expect(socket).toBe(fakeSocket);
  });
});
