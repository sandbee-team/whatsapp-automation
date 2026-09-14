/**
 * modules/broadcasts (P23 + P23a) - public barrel. Re-exports unit-owned
 * sub-barrels so parallel work units never edit one shared file:
 *   engine.public.ts    - snapshot + expansion workers, budget (P23 U4)
 *   lifecycle.public.ts - repo, lifecycle service, routes (P23 U5)
 *   epoch.public.ts     - epoch-stranding sweep + restamp routes (P23 U6)
 *   preflight.public.ts - pre-flight quote repo/service/route (P23a U1)
 *   funnel.public.ts    - counter recompute, completed, progress emit (P23a U2)
 * Outside callers import from this index only (no deep module imports).
 */
export * from './engine.public.js';
export * from './lifecycle.public.js';
export * from './epoch.public.js';
export * from './preflight.public.js';
export * from './funnel.public.js';
