import { Browsers, DEFAULT_CONNECTION_CONFIG, makeWASocket } from 'baileys';
import type {
  AuthenticationState,
  CacheStore,
  UserFacingSocketConfig,
  WAMessageKey,
  proto,
} from 'baileys';

/**
 * socket-factory.ts (P08 U1 step 2) - `buildSocketConfig` + `createBaileysSocket`.
 *
 * Everything that makes a Baileys socket's identity and history behaviour
 * deterministic and bounded lives here, in exactly one place:
 *  - ONE constant browser identity (`BROWSER_IDENTITY`, evaluated once at
 *    module load into a frozen tuple) - never derived from a random source
 *    or the wall clock. Baileys fingerprints a linked device by this
 *    triple; a randomised identity would look like device-rotation evasion
 *    (forbidden, core invariant 6), so it must be one constant, always.
 *  - history/presence/preview sync is fully OFF (`syncFullHistory: false`,
 *    `markOnlineOnConnect: false`, `shouldSyncHistoryMessage: () => false`,
 *    `generateHighQualityLinkPreview: false`) - WP never wants Baileys
 *    pulling a phone's full chat history or flipping presence.
 *  - every optional Baileys-side cache is a small, size-bounded in-memory
 *    LRU (`makeBoundedCacheStore`) rather than Baileys' own unbounded
 *    default (`undefined`, which Baileys treats as "no cache" for some and
 *    an internal unbounded map for others depending on version - binding
 *    our own means WP controls the ceiling regardless).
 *  - `auth` and `getMessage` are ALWAYS caller-injected: this factory never
 *    builds a `SignalKeyStore` or a message store itself (P07's
 *    `EncryptedAuthStore`/`bounded-key-store.ts` own that). The P08 caller
 *    passes an async `() => undefined` `getMessage` stub; real Postgres-backed
 *    message lookup lands in P11/P12 (see `deps.getMessage`'s doc comment).
 *
 * RUNTIME ASSERTION (`assertKnownConfigKeys`, run once at module init against
 * this module's own default-deps build): every key this factory sets must
 * either already be a key of Baileys' own `DEFAULT_CONNECTION_CONFIG`, or be
 * explicitly allow-listed in `REQUIRED_RUNTIME_KEYS` with a one-line reason.
 * A typo'd/renamed key that is neither throws at init - it must never
 * silently fall through to an unbounded Baileys default.
 */

const BROWSER_IDENTITY: readonly [string, string, string] = Object.freeze(
  Browsers.ubuntu('Chrome'),
) as readonly [string, string, string];

/** Max entries for every bounded in-process cache this factory binds. */
export const SOCKET_CACHE_MAX_ENTRIES = 1000;

/**
 * Keys `buildSocketConfig` sets that are legitimately ABSENT from Baileys'
 * own `DEFAULT_CONNECTION_CONFIG` (verified empirically against the pinned
 * 7.0.0-rc14 `DEFAULT_CONNECTION_CONFIG` export - see socket-config.test.ts).
 * Capped at 4 by design: a 5th absent key means either drop it from the
 * config we build, or promote it to a default-backed key - never grow this
 * list past 4 silently.
 */
export const REQUIRED_RUNTIME_KEYS: readonly string[] = [
  // qrTimeout: optional in SocketConfig; Baileys' own default omits it
  // entirely (falls back to an internal constant) rather than listing it in
  // DEFAULT_CONNECTION_CONFIG - WP sets it explicitly (45s) instead.
  'qrTimeout',
  // msgRetryCounterCache: optional cache field, absent from
  // DEFAULT_CONNECTION_CONFIG (Baileys leaves it `undefined` there) - WP
  // binds a size-bounded store so retry-count tracking cannot grow unbounded.
  'msgRetryCounterCache',
  // userDevicesCache: same story - optional, absent from the defaults,
  // WP binds a bounded store instead of leaving Baileys' fallback behavior.
  'userDevicesCache',
];

/**
 * FIX BATCH B / B3: the "capped at 4 by design" rule in `REQUIRED_RUNTIME_KEYS`'s
 * own doc comment used to be documentation only - nothing enforced it, so a
 * 5th entry could be added silently. Enforced here, at module init, so a
 * violation fails loudly (import-time throw) rather than depending on a test
 * being remembered/kept in sync.
 */
if (REQUIRED_RUNTIME_KEYS.length > 4) {
  throw new Error(
    `socket-factory: REQUIRED_RUNTIME_KEYS has grown to ${String(REQUIRED_RUNTIME_KEYS.length)} entries ` +
      `(cap is 4) - drop an entry back to a DEFAULT_CONNECTION_CONFIG-backed key, or treat this as a ` +
      `deliberate cap change requiring review, not a silent addition`,
  );
}

/**
 * A minimal, size-bounded LRU `CacheStore` (Map iteration order = insertion
 * order; delete-then-set on every touch turns that into LRU order). Kept
 * local to this module (no dependency on the auth-state package's own
 * bounded store, which is a durable-store-backed cache with different
 * semantics) - this one is purely transient, in-process, never persisted.
 */
function makeBoundedCacheStore(maxEntries: number): CacheStore {
  const cache = new Map<string, unknown>();

  function touch(key: string, value: unknown): void {
    if (cache.has(key)) {
      cache.delete(key);
    }
    cache.set(key, value);
    while (cache.size > maxEntries) {
      const lruKey = cache.keys().next().value as string | undefined;
      if (lruKey === undefined) break;
      cache.delete(lruKey);
    }
  }

  return {
    get<T>(key: string): T | undefined {
      return cache.get(key) as T | undefined;
    },
    set<T>(key: string, value: T): void {
      touch(key, value);
    },
    del(key: string): void {
      cache.delete(key);
    },
    flushAll(): void {
      cache.clear();
    },
  };
}

/** Port for reading a previously-sent message back (retry support). P08 callers pass a stub; real read lands in P11/P12. */
export type GetMessagePort = (key: WAMessageKey) => Promise<proto.IMessage | undefined>;

/** Minimal logger shape this factory requires - satisfied by baileys' own `ILogger`. */
export interface SocketFactoryLogger {
  level: string;
  child(obj: Record<string, unknown>): SocketFactoryLogger;
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface BuildSocketConfigDeps {
  /** P07's `EncryptedAuthStore`-backed `SignalKeyStore`, plus `creds` - built by the caller, never by this factory. */
  auth: AuthenticationState;
  /** Shared logger, bound to level 'warn' by the caller (server-kit's shared pino). */
  logger: SocketFactoryLogger;
  /** Stub in P08 (`async () => undefined`); real Postgres-backed lookup lands in P11/P12. */
  getMessage: GetMessagePort;
  /**
   * P10 Unit U2 (ADR 0032): overrides Baileys' own `waWebSocketUrl` default
   * (`wss://web.whatsapp.com/ws/chat`, already a `DEFAULT_CONNECTION_CONFIG`
   * key - no `REQUIRED_RUNTIME_KEYS` entry needed). Data, not a fork of this
   * factory: production callers omit it and get the real endpoint; the P10
   * measurement fleet passes a local `ws://127.0.0.1:<port>` peer URL so the
   * REAL socket-construction path (this function, unchanged) is what gets
   * measured, never a parallel factory.
   */
  waWebSocketUrl?: string;
  /**
   * P10 Unit U2 (ADR 0032): overrides Baileys' own `connectTimeoutMs`
   * default (20_000ms, already a `DEFAULT_CONNECTION_CONFIG` key). The
   * measurement fleet raises this so a socket held resident at the
   * awaited-serverHello point does not self-time-out during a soak.
   */
  connectTimeoutMs?: number;
}

export function buildSocketConfig(deps: BuildSocketConfigDeps): UserFacingSocketConfig {
  const config: UserFacingSocketConfig = {
    auth: deps.auth,
    logger: deps.logger,
    getMessage: deps.getMessage,
    browser: BROWSER_IDENTITY as unknown as UserFacingSocketConfig['browser'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    shouldSyncHistoryMessage: () => false,
    generateHighQualityLinkPreview: false,
    qrTimeout: 45_000,
    msgRetryCounterCache: makeBoundedCacheStore(SOCKET_CACHE_MAX_ENTRIES),
    userDevicesCache: makeBoundedCacheStore(SOCKET_CACHE_MAX_ENTRIES),
    ...(deps.waWebSocketUrl !== undefined ? { waWebSocketUrl: deps.waWebSocketUrl } : {}),
    ...(deps.connectTimeoutMs !== undefined ? { connectTimeoutMs: deps.connectTimeoutMs } : {}),
  };
  assertKnownConfigKeys(config);
  return config;
}

/**
 * Throws if any key of `config` is neither a `DEFAULT_CONNECTION_CONFIG` key
 * nor in `REQUIRED_RUNTIME_KEYS` - see module doc comment. Exported so the
 * test suite can exercise a typo'd-key fixture directly.
 */
export function assertKnownConfigKeys(config: Record<string, unknown>): void {
  const defaultKeys = new Set(Object.keys(DEFAULT_CONNECTION_CONFIG));
  const requiredRuntimeKeys = new Set(REQUIRED_RUNTIME_KEYS);
  for (const key of Object.keys(config)) {
    if (!defaultKeys.has(key) && !requiredRuntimeKeys.has(key)) {
      throw new Error(
        `socket-factory: config key '${key}' is neither a Baileys DEFAULT_CONNECTION_CONFIG key ` +
          `nor listed in REQUIRED_RUNTIME_KEYS - refusing to build (a typo must fail loudly, not fall ` +
          `back to an unbounded Baileys default)`,
      );
    }
  }
}

export interface CreateBaileysSocketOverrides {
  /** Test-only seam: inject a fake `makeWASocket` instead of the real one. */
  makeWASocketImpl?: typeof makeWASocket;
}

export function createBaileysSocket(
  deps: BuildSocketConfigDeps,
  overrides: CreateBaileysSocketOverrides = {},
): ReturnType<typeof makeWASocket> {
  const config = buildSocketConfig(deps);
  const impl = overrides.makeWASocketImpl ?? makeWASocket;
  return impl(config);
}
