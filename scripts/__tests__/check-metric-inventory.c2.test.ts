import { describe, expect, it } from 'vitest';
import {
  checkMetricInventory,
  scanDynamicMetricNameViolations,
  scanMetricRegistrations,
  runCheckMetricInventory,
} from '../check-metric-inventory.js';

/**
 * check-metric-inventory.c2.test.ts (P25 SESSION-PROTOCOL C2 edge-case
 * pass) - hunt item (a): a dynamic metric name (template literal or bare
 * variable as the first argument to counter/gauge/histogram) must never
 * silently pass this guard. Before the fix in guards/metric-inventory-lib.ts
 * (scanDynamicMetricNameViolations), such a registration matched NEITHER
 * REGISTRATION_CALL_PATTERN nor any existing violation clause - it was
 * invisible to the whole guard. Hunt item (b): two registrations of the
 * SAME name in two different files is already a violation
 * (metric-inventory-lib.ts's "modules.size > 1" clause) - pinned here too
 * since it was untested.
 */

describe('a_dynamic_metric_name_is_never_silently_invisible_to_the_guard', () => {
  it('a template-literal metric name is flagged as a dynamic-name violation', () => {
    const files = [
      {
        path: 'app/backend/src/modules/x/dynamic-template-metrics.ts',
        content: `
          const reason = 'whatever';
          const dynamicTotal = registry.counter(\`wp_dynamic_\${reason}_total\`, 'A dynamically named metric');
        `,
      },
    ];

    // The plain scan never even sees this registration - proving the gap
    // that made it invisible before the fix.
    const plainScan = scanMetricRegistrations(files);
    expect(plainScan.some((r) => r.name.startsWith('wp_dynamic_'))).toBe(false);

    const dynamicViolations = scanDynamicMetricNameViolations(files);
    expect(
      dynamicViolations.some(
        (v) => v.file === files[0]?.path && v.message.includes('dynamic metric name'),
      ),
    ).toBe(true);
  });

  it('a bare-variable metric name is flagged as a dynamic-name violation', () => {
    const files = [
      {
        path: 'app/backend/src/modules/x/dynamic-variable-metrics.ts',
        content: `
          const metricName = 'wp_variable_total';
          const total = registry.counter(metricName, 'A variable-named metric');
        `,
      },
    ];

    const dynamicViolations = scanDynamicMetricNameViolations(files);
    expect(dynamicViolations.some((v) => v.file === files[0]?.path)).toBe(true);
  });

  it('a plain single-quoted literal registration is NEVER flagged as dynamic', () => {
    const files = [
      {
        path: 'app/backend/src/modules/x/plain-literal-metrics.ts',
        content: `
          const total = registry.counter('wp_plain_literal_total', 'A normal metric');
        `,
      },
    ];

    const dynamicViolations = scanDynamicMetricNameViolations(files);
    expect(dynamicViolations).toEqual([]);
  });

  it('a double-quoted literal is also flagged (only single-quoted literals are the accepted convention)', () => {
    const files = [
      {
        path: 'app/backend/src/modules/x/double-quoted-metrics.ts',
        content: `
          const total = registry.counter("wp_double_quoted_total", 'A double-quoted metric');
        `,
      },
    ];

    const dynamicViolations = scanDynamicMetricNameViolations(files);
    expect(dynamicViolations.some((v) => v.file === files[0]?.path)).toBe(true);
  });

  it('test/fixture files are exempt, same as the plain scan', () => {
    const files = [
      {
        path: 'scripts/guards/__fixtures__/dynamic-metrics.ts',
        content: `
          const total = registry.counter(\`wp_fixture_\${'x'}_total\`, 'fixture only');
        `,
      },
    ];

    expect(scanDynamicMetricNameViolations(files)).toEqual([]);
  });

  it('the real committed tree has zero dynamic-metric-name violations', () => {
    const result = runCheckMetricInventory();
    expect(result.violations.filter((v) => v.message.includes('dynamic metric name'))).toEqual([]);
  });
});

describe('two_registrations_of_the_same_name_in_two_files_is_a_violation', () => {
  it('flags cross-module duplicate registrations of one metric name', () => {
    const files = [
      {
        path: 'app/backend/src/modules/x/first-file.ts',
        content: `
          const total = registry.counter('wp_duplicate_across_files_total', 'First');
        `,
      },
      {
        path: 'app/backend/src/modules/y/second-file.ts',
        content: `
          const total = registry.counter('wp_duplicate_across_files_total', 'Second');
        `,
      },
    ];
    const inventory = [
      {
        name: 'wp_duplicate_across_files_total',
        type: 'counter' as const,
        labels: [],
        module: 'app/backend/src/modules/x/first-file.ts',
        alerts: false,
        help: 'First',
      },
    ];

    const registrations = scanMetricRegistrations(files);
    const violations = checkMetricInventory(registrations, inventory, []);

    expect(violations.some((v) => v.message.includes('registered from more than one module'))).toBe(
      true,
    );
  });
});
