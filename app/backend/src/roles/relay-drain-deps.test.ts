import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * relay-drain-deps.test.ts (P15 C1 FIX F1 / CRIT-2) - proves `roles/relay.ts`
 * wires the SAME `drainDeps` object (including `webhookFanout`) to BOTH the
 * fixed-interval drain timer AND the NOTIFY-wake drain call. Before this fix,
 * the timer's `drainOnce` call carried `webhookFanout` but the wake call
 * omitted it - `drainOnce` still marks a webhook-fanned row `published_at`
 * unconditionally regardless of whether `webhookFanout` is present (see
 * `relay-loop.ts`'s own `toMarkPublished`), so the wake path (which usually
 * wins the race after every `emit()` commit, since it fires on the SAME
 * NOTIFY the business transaction's commit triggers) silently published rows
 * with NO durable `webhook_deliveries` row ever written.
 *
 * A real end-to-end proof would require triggering a live Postgres LISTEN
 * notification mid-test; `roles/relay.ts` self-invokes `main()` at import
 * time and is not structured for dependency injection (same constraint this
 * file's own `client.on('error', ...)` fix documents), so this is a
 * source-text structural proof instead: both `drainOnce(...)` call sites in
 * the compiled source must spread/reference the exact same `drainDeps`.
 *
 * NOT a role entrypoint: `scripts/check-role-boot.ts`'s glob also matches
 * sibling test files directly under `roles/` - this file reads source text,
 * never boots a role and never calls `assertDbPreconditionsOrExit` (that
 * gate belongs to `roles/relay.ts`'s own `main()`).
 * identifier, and that identifier's own object literal must itself include
 * `webhookFanout`.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RELAY_SOURCE = readFileSync(path.join(__dirname, 'relay.ts'), 'utf8');

describe('roles/relay.ts - drainOnce wiring parity (F1 / CRIT-2)', () => {
  it('both_drainOnce_call_sites_use_the_same_hoisted_drainDeps_object', () => {
    const drainOnceCallLines = RELAY_SOURCE.split('\n')
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /drainOnce\(/.test(line));

    expect(drainOnceCallLines.length).toBeGreaterThanOrEqual(2);

    // Every drainOnce( call must be immediately followed (within the next
    // couple of lines) by a reference to the single hoisted `drainDeps`
    // identifier - never an inline object literal at either call site.
    for (const { index } of drainOnceCallLines) {
      const window = RELAY_SOURCE.split('\n')
        .slice(index, index + 3)
        .join('\n');
      expect(window).toMatch(/drainOnce\(\s*drainDeps\s*\)/);
    }
  });

  it('the_hoisted_drainDeps_object_carries_webhookFanout', () => {
    const drainDepsDeclMatch = /const drainDeps[^;]*=\s*\{([\s\S]*?)\};/.exec(RELAY_SOURCE);
    expect(drainDepsDeclMatch).not.toBeNull();
    expect(drainDepsDeclMatch?.[1]).toMatch(/webhookFanout/);
  });
});
