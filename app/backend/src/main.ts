import { loadConfig } from './platform/config.js';

/**
 * main.ts (P04a Unit UA6) - the single process entrypoint. Reads `ROLE` and
 * boots exactly one role ('api' | 'migrate' | 'session-worker' | 'cron' |
 * 'relay') by dynamically importing its entrypoint module - each role file
 * (`roles/api.ts`, `roles/migrate.ts`, `roles/session-worker.ts`,
 * `roles/cron.ts`, `roles/relay.ts`) runs its own top-level `main().catch(...)` on import and
 * wires its own graceful shutdown (SIGTERM/SIGINT handlers).
 *
 * M14 (P04a FIXB): `ROLE` is read via `loadConfig` (the ONLY file allowed to
 * touch `process.env`, core rule), not `process.env` directly.
 *
 * P08 Unit U6b: adds `'session-worker'` to the dispatch.
 * P12 Unit U4: adds `'cron'` to the dispatch.
 */

async function main(): Promise<void> {
  const { ROLE } = loadConfig();
  if (!ROLE) {
    throw new Error(
      "ROLE must be one of 'api' | 'migrate' | 'session-worker' | 'cron' (got: unset)",
    );
  }

  if (ROLE === 'migrate') {
    await import('./roles/migrate.js');
  } else if (ROLE === 'session-worker') {
    await import('./roles/session-worker.js');
  } else if (ROLE === 'cron') {
    await import('./roles/cron.js');
  } else if (ROLE === 'relay') {
    await import('./roles/relay.js');
  } else {
    await import('./roles/api.js');
  }
}

main().catch((err: unknown) => {
  const name = err instanceof Error ? err.name : 'Error';
  const message = err instanceof Error ? err.message : String(err);
  console.error(`${name}: ${message}`);
  process.exit(1);
});
