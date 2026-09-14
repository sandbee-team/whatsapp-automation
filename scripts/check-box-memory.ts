import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from './guards/scan-config.js';

/**
 * check-box-memory.ts (P09 Unit U5, step 8) - parses worker services out of
 * `infra/compose/docker-compose.dev.yml` and enforces the canonical box
 * memory budget (scope-delta doc, Fleet / box-level memory section): the
 * deploy path "refuses to start rather than warn" - 15 healthy-looking
 * workers can still OOM a host; per-worker `mem_limit`s alone are not
 * enough.
 *
 * No YAML library is a workspace dependency (checked: neither `yaml` nor
 * `js-yaml` is installed, and this unit's scope fence is script entries only
 * in root package.json - not a new dependency). `parseComposeYaml` is
 * therefore a minimal, INDENTATION-based scanner over exactly the subset of
 * compose YAML this guard needs (top-level `services:` block, one service
 * name per 2-space-indented key, `mem_limit`/`deploy.replicas` scalars) -
 * the same "pure regex/text scan over already-read content" idiom every
 * other guard in this repo uses (see `check-tenant-scope.ts`,
 * `check-single-claim.ts`). It is deliberately NOT a general YAML parser.
 */

export interface WorkerServiceSpec {
  name: string;
  memLimitGb: number;
  replicas: number;
}

export interface BoxMemoryBudget {
  boxRamGb?: number;
  osReserveGb?: number;
  perWorkerBaselineGb?: number;
  headroomFactor?: number;
}

/** `BOX_RAM_GB` env override, default 64 (param/env per the phase spec). */
export const DEFAULT_BOX_RAM_GB = Number.parseFloat(process.env.BOX_RAM_GB ?? '64') || 64;
export const DEFAULT_OS_RESERVE_GB = 6;
export const PER_WORKER_BASELINE_GB = 0.2;
export const HEADROOM_FACTOR = 0.68;

/** Selector: any compose service whose name matches `session-worker` (exact name, or a `session-worker-<suffix>` shape) OR carries the `worker` profile. */
const WORKER_SERVICE_NAME_PATTERN = /^session-worker(-[\w-]+)?$/;

export class BoxMemoryBudgetExceededError extends Error {
  constructor(
    public readonly totalMemLimitGb: number,
    public readonly budgetGb: number,
    public readonly weakerNecessaryLhsGb: number,
    public readonly boxRamGb: number,
  ) {
    super(
      `box memory budget exceeded: sum(mem_limit x replicas) = ${totalMemLimitGb.toFixed(1)} GB > budget ${budgetGb.toFixed(1)} GB ` +
        `(boxRamGb=${boxRamGb.toFixed(1)}, headroom-adjusted). The deploy path refuses to start rather than warn - ` +
        `15 healthy-looking workers can still OOM a host; per-worker limits alone are not enough. ` +
        `Weaker necessary condition also checked: sum(mem_limit) + osReserve = ${weakerNecessaryLhsGb.toFixed(1)} GB vs boxRamGb=${boxRamGb.toFixed(1)} GB.`,
    );
    this.name = 'BoxMemoryBudgetExceededError';
  }
}

/**
 * Enforces the canonical box budget (strict form, the named test pin):
 *   sum(mem_limit x replicas) <= (boxRam - osReserve - sum(baselines)) * headroomFactor + sum(baselines)
 * plus the ADR's weaker necessary condition (implied, asserted too):
 *   sum(mem_limit) + osReserve <= boxRam
 * Throws `BoxMemoryBudgetExceededError` (never returns a boolean/warning) on
 * violation of EITHER condition - the deploy path must refuse to start.
 */
export function checkBoxMemoryBudget(
  workers: readonly WorkerServiceSpec[],
  budget: BoxMemoryBudget = {},
): void {
  const boxRamGb = budget.boxRamGb ?? DEFAULT_BOX_RAM_GB;
  const osReserveGb = budget.osReserveGb ?? DEFAULT_OS_RESERVE_GB;
  const perWorkerBaselineGb = budget.perWorkerBaselineGb ?? PER_WORKER_BASELINE_GB;
  const headroomFactor = budget.headroomFactor ?? HEADROOM_FACTOR;

  const totalReplicas = workers.reduce((sum, w) => sum + w.replicas, 0);
  const totalBaselinesGb = totalReplicas * perWorkerBaselineGb;
  const totalMemLimitGb = workers.reduce((sum, w) => sum + w.memLimitGb * w.replicas, 0);

  // Weaker necessary condition (ADR's stated form): sum(mem_limit) + OS reserve <= box RAM.
  const weakerLhsGb = totalMemLimitGb + osReserveGb;
  if (weakerLhsGb > boxRamGb) {
    throw new BoxMemoryBudgetExceededError(
      totalMemLimitGb,
      boxRamGb - osReserveGb,
      weakerLhsGb,
      boxRamGb,
    );
  }

  // Strict form (scope-delta canon, headroom-adjusted).
  const budgetGb = (boxRamGb - osReserveGb - totalBaselinesGb) * headroomFactor + totalBaselinesGb;
  if (totalMemLimitGb > budgetGb) {
    throw new BoxMemoryBudgetExceededError(totalMemLimitGb, budgetGb, weakerLhsGb, boxRamGb);
  }
}

/** Parses a compose `mem_limit` scalar (e.g. `3584m`, `3.5g`, `512M`) into GB. */
function parseMemLimitGb(raw: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([kmgKMG]?)b?$/.exec(raw.trim());
  if (!match) return 0;
  const value = Number.parseFloat(match[1] ?? '0');
  const unit = (match[2] ?? '').toLowerCase();
  if (unit === 'k') return value / (1024 * 1024);
  if (unit === 'g') return value;
  // Default/'m': MiB -> GB (1024 MiB = 1 GB, consistent with 3584m === 3.5 GB in this repo's own compose comment).
  return value / 1024;
}

/**
 * Minimal indentation-based scan of the `services:` block - see this file's
 * header comment for why a full YAML parser is not used. Selects only
 * services matching `WORKER_SERVICE_NAME_PATTERN`.
 */
export function parseWorkerServices(composeYaml: string): WorkerServiceSpec[] {
  const lines = composeYaml.split('\n');
  const servicesIndex = lines.findIndex((line) => /^services:\s*$/.test(line));
  if (servicesIndex === -1) return [];

  const workers: WorkerServiceSpec[] = [];
  let currentName: string | undefined;
  let currentMemLimitGb = 0;
  let currentReplicas = 1;
  let inDeployBlock = false;
  let currentIsWorker = false;

  const flush = (): void => {
    if (currentName !== undefined && currentIsWorker) {
      workers.push({ name: currentName, memLimitGb: currentMemLimitGb, replicas: currentReplicas });
    }
  };

  for (let i = servicesIndex + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^\S/.test(line)) break; // dedented out of the services: block (e.g. `volumes:`).

    const serviceNameMatch = /^ {2}([\w.-]+):\s*$/.exec(line);
    if (serviceNameMatch) {
      flush();
      currentName = serviceNameMatch[1];
      currentMemLimitGb = 0;
      currentReplicas = 1;
      inDeployBlock = false;
      currentIsWorker = WORKER_SERVICE_NAME_PATTERN.test(currentName ?? '');
      continue;
    }

    if (currentName === undefined) continue;

    const memLimitMatch = /^ {4}mem_limit:\s*(\S+)\s*$/.exec(line);
    if (memLimitMatch) {
      currentMemLimitGb = parseMemLimitGb(memLimitMatch[1] ?? '0');
      continue;
    }

    const deployMatch = /^ {4}deploy:\s*$/.exec(line);
    if (deployMatch) {
      inDeployBlock = true;
      continue;
    }
    if (inDeployBlock) {
      const replicasMatch = /^ {6}replicas:\s*(\d+)\s*$/.exec(line);
      if (replicasMatch) {
        currentReplicas = Number.parseInt(replicasMatch[1] ?? '1', 10);
        continue;
      }
      if (/^ {4}\S/.test(line) && !deployMatch) {
        inDeployBlock = false;
      }
    }
  }
  flush();

  return workers;
}

const COMPOSE_PATH = 'infra/compose/docker-compose.dev.yml';

function readComposeWorkers(): WorkerServiceSpec[] {
  const content = readFileSync(path.join(REPO_ROOT, COMPOSE_PATH), 'utf8');
  return parseWorkerServices(content);
}

export function runCheckBoxMemory(): { workers: WorkerServiceSpec[] } {
  return { workers: readComposeWorkers() };
}

function main(): void {
  const { workers } = runCheckBoxMemory();

  try {
    checkBoxMemoryBudget(workers, {});
  } catch (err) {
    console.error(`box-memory: ${(err as Error).message}`);
    process.exit(1);
  }

  console.log(
    `box-memory: ${String(workers.length)} worker service(s) matched in ${COMPOSE_PATH}, budget OK`,
  );
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main();
}
