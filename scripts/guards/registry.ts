import { runCheckTree } from '../check-tree.js';
import { runCheckTenantScope, TENANT_SCOPE_GLOBS } from '../check-tenant-scope.js';
import {
  runCheckSendOrigin,
  SEND_ORIGIN_DTO_GLOBS,
  SEND_ORIGIN_EXEMPT_GLOBS,
} from '../check-send-origin.js';
import { runCheckCopy, COPY_GLOBS } from '../check-copy.js';
import { RAW_HEX_GLOBS } from '../check-no-raw-hex.js';
import { UI_CLIENT_DIRECTIVE_GLOBS } from '../check-ui-client-directive.js';
import { runNoRawHexGuard, runUiClientDirectiveGuard } from './run-source-guards.js';
import { runDepcruise, runEslintGuard } from './shell-out-guards.js';
import { runCheckSqlLint, SQL_LINT_GLOBS } from '../check-sql-lint.js';
import { runCheckRoleBoot, ROLE_BOOT_GLOBS } from '../check-role-boot.js';
import { runCheckSingleClaim, SINGLE_CLAIM_GLOBS } from '../check-single-claim.js';
import { runCheckSingleReserve, SINGLE_RESERVE_GLOBS } from '../check-single-reserve.js';
import { runCheckSingleDebit, SINGLE_DEBIT_GLOBS } from '../check-single-debit.js';
import { runCheckNoAutoRequeue, NO_AUTO_REQUEUE_GLOBS } from '../check-no-auto-requeue.js';
import {
  runCheckSerialisationBoundary,
  SERIALISATION_BOUNDARY_GLOBS,
} from '../check-serialisation-boundary.js';
import { runCheckShutdownPurity, SHUTDOWN_PURITY_GLOBS } from '../check-shutdown-purity.js';
import {
  runCheckPlacementNeutrality,
  PLACEMENT_NEUTRALITY_GLOBS,
} from '../check-placement-neutrality.js';
import { runCheckCapacityGate, CAPACITY_GATE_GLOBS } from '../check-capacity-gate.js';
import { runCheckNoDirectPublish, NO_DIRECT_PUBLISH_GLOBS } from '../check-no-direct-publish.js';
import { INSECURE_TLS_GLOBS } from '../check-no-insecure-tls.js';
import { runCheckHealthWriters, HEALTH_WRITERS_GLOBS } from '../check-health-writers.js';
import { runCheckSchedulerQueries, SCHEDULER_LOOP_MODULES } from '../check-scheduler-queries.js';
import {
  runCheckForbiddenMechanisms,
  FORBIDDEN_MECHANISM_GLOBS,
} from '../check-forbidden-mechanisms.js';
import { runCheckNoBulkLookup, NO_BULK_LOOKUP_GLOBS } from '../check-no-bulk-lookup.js';
import { runCheckMetricInventory, METRIC_INVENTORY_GLOBS } from '../check-metric-inventory.js';
import { runCheckDashboards, DASHBOARD_GLOBS } from '../check-dashboards.js';
import { runCheckAlertRules } from '../check-alert-rules.js';
import { runBoxMemoryGuard, runInsecureTlsGuard } from './registry-adapters.js';
import { SECURITY_SCAN_GUARDS } from './security-scan-guards.js';
import {
  ARTIFACT_EXCLUSIONS,
  CONTENT_EXCLUSIONS,
  REPO_ROOT,
  SCAN_GLOBS,
  parsePhaseStatus,
  resolveFiles,
} from './scan-config.js';
import type { GuardResult, GuardViolation, PhaseStatus } from './scan-config.js';

/**
 * The guard registry + meta-assertion (P00 step 3). Guards are registered
 * here and every guard must either match at least one real repo file or
 * declare an `activatesIn` phase that has not yet shipped its trigger
 * surface (see `plan/README.md`).
 *
 * `REPO_ROOT`/`resolveFiles`/the scan-exclusion lists/the `Guard*` types live
 * in `./scan-config.js` (a leaf module, re-exported below) - this file cannot
 * define them itself without a circular import (see `scan-config.ts`'s header).
 */
export {
  ARTIFACT_EXCLUSIONS,
  CONTENT_EXCLUSIONS,
  REPO_ROOT,
  SCAN_GLOBS,
  parsePhaseStatus,
  resolveFiles,
};
export type { GuardResult, GuardViolation, PhaseStatus };

export interface Guard {
  name: string;
  globs: string[];
  /** Phase id (e.g. "P02") that first gives this guard something real to match. */
  activatesIn?: `P${string}`;
  run(files: string[]): Promise<GuardResult> | GuardResult;
}

/** The five ADR 0014 source trees, workspace TS/TSX only. */
const ESLINT_GUARD_GLOBS = [
  'app/**/src/**/*.{ts,tsx}',
  'admin/**/src/**/*.{ts,tsx}',
  'website/src/**/*.{ts,tsx}',
  'packages/*/src/**/*.{ts,tsx}',
  'db/src/**/*.{ts,tsx}',
];

/** Guard registrations. Each entry's globs must match at least one real repo file, or declare `activatesIn`. */
export const GUARDS: Guard[] = [
  {
    name: 'depcruise',
    globs: [
      'app/**/src/**/*.ts',
      'admin/**/src/**/*.ts',
      'website/src/**/*.ts',
      'packages/*/src/**/*.ts',
      'db/src/**/*.ts',
    ],
    run: runDepcruise,
  },
  {
    name: 'depcruise:no-deep-module-import',
    globs: ['app/backend/src/modules/**/*.{ts,tsx}'],
    activatesIn: 'P11',
    run: runDepcruise,
  },
  {
    name: 'depcruise:api-never-imports-provider',
    globs: ['app/backend/src/roles/api.ts', 'app/backend/src/provider/**/*.{ts,tsx}'],
    activatesIn: 'P08',
    run: runDepcruise,
  },
  {
    name: 'depcruise:server-kit-never-imports-baileys',
    globs: ['packages/server-kit/src/**/*.ts'],
    run: runDepcruise,
  },
  {
    name: 'eslint:no-plain-set',
    globs: ESLINT_GUARD_GLOBS,
    run: (files) => runEslintGuard('wp/no-plain-set', files),
  },
  {
    name: 'eslint:no-offset-pagination',
    globs: ESLINT_GUARD_GLOBS,
    run: (files) => runEslintGuard('wp/no-offset-pagination', files),
  },
  {
    name: 'eslint:key-construction',
    globs: ESLINT_GUARD_GLOBS,
    run: (files) => runEslintGuard('wp/key-construction', files),
  },
  {
    name: 'eslint:domain-determinism',
    globs: ['packages/domain/src/**/*.{ts,tsx}'],
    run: (files) => runEslintGuard('wp/domain-no-wallclock', files),
  },
  {
    name: 'check-tree',
    globs: ['*'],
    run: runCheckTree,
  },
  {
    name: 'check-tenant-scope',
    globs: TENANT_SCOPE_GLOBS,
    run: runCheckTenantScope,
  },
  {
    name: 'check-send-origin:dto-origin',
    globs: SEND_ORIGIN_DTO_GLOBS,
    run: runCheckSendOrigin,
  },
  {
    name: 'check-send-origin:exempt-origins',
    globs: SEND_ORIGIN_EXEMPT_GLOBS,
    run: runCheckSendOrigin,
  },
  {
    name: 'check-copy',
    globs: COPY_GLOBS,
    run: runCheckCopy,
  },
  {
    name: 'sql-lint',
    globs: SQL_LINT_GLOBS,
    run: runCheckSqlLint,
  },
  {
    name: 'check-role-boot',
    globs: ROLE_BOOT_GLOBS,
    activatesIn: 'P04', // historical - see depcruise:api-never-imports-provider's roles/api.ts hint.
    run: runCheckRoleBoot,
  },
  {
    name: 'check-single-claim',
    globs: SINGLE_CLAIM_GLOBS,
    run: runCheckSingleClaim,
  },
  {
    name: 'check-single-reserve',
    globs: SINGLE_RESERVE_GLOBS,
    run: runCheckSingleReserve,
  },
  {
    name: 'check-single-debit',
    globs: SINGLE_DEBIT_GLOBS,
    run: runCheckSingleDebit,
  },
  {
    name: 'check-no-auto-requeue',
    globs: NO_AUTO_REQUEUE_GLOBS,
    run: runCheckNoAutoRequeue,
  },
  { name: 'check-no-raw-hex', globs: RAW_HEX_GLOBS, run: runNoRawHexGuard },
  {
    name: 'check-serialisation-boundary',
    globs: SERIALISATION_BOUNDARY_GLOBS,
    activatesIn: 'P07',
    run: runCheckSerialisationBoundary,
  },
  // packages/ui/src has no .tsx files yet (U4 adds the first components).
  {
    name: 'check-ui-client-directive',
    globs: UI_CLIENT_DIRECTIVE_GLOBS,
    activatesIn: 'P05',
    run: runUiClientDirectiveGuard,
  },
  {
    name: 'check-shutdown-purity',
    globs: SHUTDOWN_PURITY_GLOBS,
    activatesIn: 'P09',
    run: runCheckShutdownPurity,
  },
  {
    name: 'check-placement-neutrality',
    globs: PLACEMENT_NEUTRALITY_GLOBS,
    activatesIn: 'P09',
    run: runCheckPlacementNeutrality,
  },
  {
    name: 'check-box-memory',
    globs: ['infra/compose/docker-compose.dev.yml'],
    activatesIn: 'P09',
    run: runBoxMemoryGuard,
  },
  {
    name: 'check-capacity-gate',
    globs: CAPACITY_GATE_GLOBS,
    activatesIn: 'P10',
    run: runCheckCapacityGate,
  },
  {
    name: 'check-no-direct-publish',
    globs: NO_DIRECT_PUBLISH_GLOBS,
    activatesIn: 'P15',
    run: runCheckNoDirectPublish,
  },
  {
    name: 'check-no-insecure-tls',
    globs: INSECURE_TLS_GLOBS,
    activatesIn: 'P15',
    run: runInsecureTlsGuard,
  },
  {
    name: 'check-health-writers',
    globs: HEALTH_WRITERS_GLOBS,
    activatesIn: 'P16',
    run: runCheckHealthWriters,
  },
  {
    name: 'check-scheduler-queries',
    globs: [...SCHEDULER_LOOP_MODULES],
    activatesIn: 'P16',
    run: runCheckSchedulerQueries,
  },
  {
    name: 'check-forbidden-mechanisms',
    globs: FORBIDDEN_MECHANISM_GLOBS,
    activatesIn: 'P16',
    run: runCheckForbiddenMechanisms,
  },
  {
    name: 'check-no-bulk-lookup',
    globs: NO_BULK_LOOKUP_GLOBS,
    activatesIn: 'P20',
    run: runCheckNoBulkLookup,
  },
  {
    name: 'check-metric-inventory',
    globs: METRIC_INVENTORY_GLOBS,
    run: runCheckMetricInventory,
  },
  {
    name: 'check-dashboards',
    globs: DASHBOARD_GLOBS,
    run: runCheckDashboards,
  },
  {
    name: 'check-alert-rules',
    globs: ['infra/observability/prometheus/rules/*.yml'],
    run: runCheckAlertRules,
  },
  ...SECURITY_SCAN_GUARDS,
];
