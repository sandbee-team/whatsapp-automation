import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { METRIC_INVENTORY } from '@wp/domain';
import {
  checkMetricInventory,
  readInstanceLabelledGauges,
  runCheckMetricInventory,
  scanMetricRegistrations,
  type MetricRegistration,
} from '../check-metric-inventory.js';
import { renderMetricManifest, MANIFEST_PATH } from '../gen-metric-manifest.js';
import { REPO_ROOT } from '../guards/scan-config.js';

/**
 * check-metric-inventory.test.ts (P25 unit U1a) - proves the guard's seven
 * clauses, the parser's multi-line robustness, the four-gauge allow-list
 * parse, and the committed manifest's agreement with METRIC_INVENTORY.
 * Inline SourceFile content, no fixture files - same idiom as
 * check-single-debit.test.ts.
 */

describe('check-metric-inventory (P25 unit U1a)', () => {
  it('a_registered_metric_missing_from_the_inventory_fails_the_build', () => {
    const files = [
      {
        path: 'app/backend/src/modules/x/ghost-metrics.ts',
        content: `
          const ghostTotal = registry.counter('wp_ghost_total', 'A metric nobody put in the inventory');
        `,
      },
    ];
    const registrations = scanMetricRegistrations(files);
    const violations = checkMetricInventory(registrations, [], []);

    expect(violations.some((v) => v.message.includes('wp_ghost_total'))).toBe(true);
  });

  it('an_inventory_entry_with_no_registration_fails_the_build', () => {
    const inventory = [
      {
        name: 'wp_never_registered_total',
        type: 'counter' as const,
        labels: [],
        module: 'app/backend/src/modules/x/y.ts',
        alerts: false,
        help: 'help text',
      },
    ];
    const violations = checkMetricInventory([], inventory, []);

    expect(
      violations.some(
        (v) =>
          v.message.includes('wp_never_registered_total') && v.message.includes('no registration'),
      ),
    ).toBe(true);
  });

  it('a_fifth_instance_id_gauge_fails_the_build', () => {
    const files = [
      {
        path: 'app/backend/src/modules/x/wallet-balance-metrics.ts',
        content: `
          const balance = registry.gauge(
            'wp_instance_wallet_balance_minor',
            'Per-instance wallet balance, minor units',
            ['instance_id'],
          );
        `,
      },
    ];
    const inventory = [
      {
        name: 'wp_instance_wallet_balance_minor',
        type: 'gauge' as const,
        labels: ['instance_id'],
        module: 'app/backend/src/modules/x/wallet-balance-metrics.ts',
        alerts: false,
        help: 'Per-instance wallet balance, minor units',
      },
    ];
    const registrations = scanMetricRegistrations(files);
    const fourAllowed = [
      'wp_instance_health_state',
      'wp_instance_link_state',
      'wp_instance_queue_depth',
      'wp_instance_oldest_queued_seconds',
    ];
    const violations = checkMetricInventory(registrations, inventory, fourAllowed);

    expect(violations.some((v) => v.message.includes('wp_instance_wallet_balance_minor'))).toBe(
      true,
    );
  });

  it('a_client_id_label_on_a_counter_fails_the_build', () => {
    const rejectedFiles = [
      {
        path: 'app/backend/src/modules/x/send-metrics.ts',
        content: `
          const sendTotal = registry.counter('wp_send_total', 'Sends', ['client_id']);
        `,
      },
    ];
    const rejectedInventory = [
      {
        name: 'wp_send_total',
        type: 'counter' as const,
        labels: ['client_id'],
        module: 'app/backend/src/modules/x/send-metrics.ts',
        alerts: false,
        help: 'Sends',
      },
    ];
    const rejectedViolations = checkMetricInventory(
      scanMetricRegistrations(rejectedFiles),
      rejectedInventory,
      [],
    );
    expect(rejectedViolations.some((v) => v.message.includes('wp_send_total'))).toBe(true);

    const acceptedFiles = [
      {
        path: 'app/backend/src/modules/x/send-metrics.ts',
        content: `
          const sendTotal = registry.counter('wp_send_total', 'Sends', ['result', 'error_class']);
        `,
      },
    ];
    const acceptedInventory = [
      {
        name: 'wp_send_total',
        type: 'counter' as const,
        labels: ['result', 'error_class'],
        module: 'app/backend/src/modules/x/send-metrics.ts',
        alerts: false,
        help: 'Sends',
      },
    ];
    const acceptedViolations = checkMetricInventory(
      scanMetricRegistrations(acceptedFiles),
      acceptedInventory,
      [],
    );
    expect(acceptedViolations).toEqual([]);
  });

  it('guard_matched_a_non_zero_file_count', () => {
    const result = runCheckMetricInventory();

    expect(result.filesScanned).toBeGreaterThan(0);
    expect(result.registrationsScanned).toBeGreaterThan(0);
    expect(result.violations).toEqual([]);
  });

  it('a_type_or_label_mismatch_fails_the_build', () => {
    const files = [
      {
        path: 'app/backend/src/modules/x/mismatch-metrics.ts',
        content: `
          const thing = registry.gauge('wp_mismatch_total', 'A thing', ['reason']);
        `,
      },
    ];
    const inventory = [
      {
        name: 'wp_mismatch_total',
        type: 'counter' as const,
        labels: ['result'],
        module: 'app/backend/src/modules/x/mismatch-metrics.ts',
        alerts: false,
        help: 'A thing',
      },
    ];
    const violations = checkMetricInventory(scanMetricRegistrations(files), inventory, []);

    expect(violations.some((v) => v.message.includes('registration type'))).toBe(true);
    expect(violations.some((v) => v.message.includes('registration labels'))).toBe(true);
  });

  it('the_policy_allow_list_parses_to_exactly_the_four_gauges', () => {
    expect(readInstanceLabelledGauges()).toEqual([
      'wp_instance_health_state',
      'wp_instance_link_state',
      'wp_instance_queue_depth',
      'wp_instance_oldest_queued_seconds',
    ]);
  });

  it('the_committed_manifest_matches_the_inventory', async () => {
    const rendered = await renderMetricManifest(METRIC_INVENTORY);
    const existing = readFileSync(MANIFEST_PATH, 'utf8');

    expect(rendered).toBe(existing);
  });

  it('multi_line_registrations_with_label_arrays_are_parsed', () => {
    const filePath = 'app/backend/src/platform/metrics/wallet-metrics.ts';
    const content = readFileSync(path.join(REPO_ROOT, filePath), 'utf8');
    const registrations: MetricRegistration[] = scanMetricRegistrations([
      { path: filePath, content },
    ]);

    const debits = registrations.find((r) => r.name === 'wp_wallet_debits_total');
    expect(debits).toBeDefined();
    expect(debits?.type).toBe('counter');
    expect(debits?.labels).toEqual(['price_key']);

    const drift = registrations.find((r) => r.name === 'wp_wallet_drift_minor');
    expect(drift).toBeDefined();
    expect(drift?.type).toBe('gauge');
    expect(drift?.labels).toEqual([]);
  });
});
