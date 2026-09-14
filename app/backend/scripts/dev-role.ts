import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childExecArgv } from '../../../scripts/measure/child-exec-argv.js';

/**
 * app/backend/scripts/dev-role.ts - the backend's `npm run dev`.
 *
 * `ROLE` selects the backend process (`api` | `session-worker` | `cron` |
 * `relay` | `migrate`, see `src/main.ts`), and in production exactly one role
 * runs per container. For a LOCAL manual review that is inconvenient: linking
 * a number needs the session worker, sending needs the worker + cron, the
 * inbox needs the relay. So `npm run dev` (= `all`) starts the four long-lived
 * roles as child processes of ONE terminal, each with its own metrics port
 * (the compose ports 9464-9467, otherwise every role would fight over the
 * `WP_METRICS_PORT` default and crash with EADDRINUSE), prefixes their output,
 * and stops them all on Ctrl+C. `npm run dev:<role>` runs exactly one role in
 * the foreground - identical to `ROLE=<role> pnpm exec tsx src/main.ts`.
 *
 * Env: `.secrets/dev.env` is loaded here (never printed) so the script works
 * from a plain shell; variables already present in the environment win, and a
 * relative `WP_KEY_RING_PATH` is resolved against the repo root because npm
 * runs this with `app/backend` as the working directory.
 *
 * Children inherit THIS process's TypeScript-capable loader flags
 * (`scripts/measure/child-exec-argv.ts`), the same idiom the P26 fleet
 * harness uses, so `src/main.ts` runs under tsx in every child.
 */

const LONG_LIVED_ROLES = ['api', 'session-worker', 'cron', 'relay'] as const;
type LongLivedRole = (typeof LONG_LIVED_ROLES)[number];
type Role = LongLivedRole | 'migrate';
type Mode = Role | 'all';

/** Mirrors infra/compose/docker-compose.dev.yml's per-role metrics ports. */
export const METRICS_PORT_BY_ROLE: Readonly<Record<Role, number>> = Object.freeze({
  api: 9464,
  'session-worker': 9465,
  cron: 9466,
  relay: 9467,
  migrate: 9468,
});

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const envFilePath = resolve(repoRoot, '.secrets/dev.env');

/** `KEY=VALUE` lines; `#` comments and blanks skipped; no interpolation, no quotes stripped beyond a matching outer pair. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = value;
  }
  return out;
}

function loadDevEnv(): void {
  if (!existsSync(envFilePath)) {
    console.error(
      `dev: ${envFilePath} not found - create it first (docs/RUNNING-LOCALLY.md, "Manual start" step 1).`,
    );
    process.exit(1);
  }
  const parsed = parseEnvFile(readFileSync(envFilePath, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  const ring = process.env.WP_KEY_RING_PATH;
  if (ring !== undefined && ring !== '' && !isAbsolute(ring)) {
    process.env.WP_KEY_RING_PATH = resolve(repoRoot, ring.replaceAll('\\', '/'));
  }
}

function parseMode(argv: readonly string[]): Mode {
  const arg = argv[0] ?? 'all';
  if (arg === 'all' || arg === 'migrate' || (LONG_LIVED_ROLES as readonly string[]).includes(arg)) {
    return arg as Mode;
  }
  console.error(
    `dev: unknown role "${arg}" - use one of all, ${LONG_LIVED_ROLES.join(', ')}, migrate`,
  );
  process.exit(2);
}

async function runOneRole(role: Role): Promise<void> {
  process.env.ROLE = role;
  if (process.env.WP_METRICS_PORT === undefined) {
    process.env.WP_METRICS_PORT = String(METRICS_PORT_BY_ROLE[role]);
  }
  await import('../src/main.js');
}

function prefixLines(child: ChildProcess, label: string, stream: NodeJS.WriteStream): void {
  const pad = label.padEnd(14);
  let carry = '';
  const onChunk = (chunk: Buffer): void => {
    const text = carry + chunk.toString('utf8');
    const lines = text.split(/\r?\n/);
    carry = lines.pop() ?? '';
    for (const line of lines) stream.write(`[${pad}] ${line}\n`);
  };
  child.stdout?.on('data', onChunk);
  child.stderr?.on('data', onChunk);
  child.on('close', () => {
    if (carry !== '') stream.write(`[${pad}] ${carry}\n`);
  });
}

function runAll(): void {
  const selfPath = fileURLToPath(import.meta.url);
  const loaderFlags = childExecArgv({ parentExecArgv: process.execArgv });
  const children = new Map<LongLivedRole, ChildProcess>();
  let exitCode = 0;
  let stopping = false;

  const stopAll = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`dev: ${signal} - stopping ${String(children.size)} role(s)\n`);
    for (const child of children.values()) child.kill(signal);
  };
  process.on('SIGINT', () => stopAll('SIGINT'));
  process.on('SIGTERM', () => stopAll('SIGTERM'));

  for (const role of LONG_LIVED_ROLES) {
    const child = spawn(process.execPath, [...loaderFlags, selfPath, role], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ROLE: role,
        WP_METRICS_PORT: String(METRICS_PORT_BY_ROLE[role]),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.set(role, child);
    prefixLines(child, role, process.stdout);
    child.on('exit', (code, signal) => {
      children.delete(role);
      const how = signal !== null ? `signal ${signal}` : `code ${String(code ?? 0)}`;
      process.stdout.write(`dev: ${role} exited (${how})\n`);
      if (!stopping && code !== null && code !== 0) exitCode = code;
      if (children.size === 0) process.exit(exitCode);
    });
  }

  process.stdout.write(
    `dev: started ${LONG_LIVED_ROLES.join(', ')} (API http://localhost:${process.env.PORT ?? '3000'}; metrics ${LONG_LIVED_ROLES.map((r) => `${r}:${String(METRICS_PORT_BY_ROLE[r])}`).join(' ')}). Ctrl+C stops all.\n`,
  );
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  loadDevEnv();
  const mode = parseMode(process.argv.slice(2));
  if (mode === 'all') {
    runAll();
  } else {
    runOneRole(mode).catch((err: unknown) => {
      console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
      process.exit(1);
    });
  }
}
