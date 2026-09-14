import '../realtime/__test-support__/stub-wp-server-kit-env.js';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createMetricsRegistry } from '@wp/server-kit';
import { bindInboundMetrics } from './metrics.js';

/**
 * metrics.test.ts (P21 Unit U6a, step 7) - proves the ADR 0018 allow-list by
 * source-scanning every registration call under `modules/inbound/` rather
 * than trusting the runtime registry alone (a registration made through a
 * re-exported factory would not show up in a purely-runtime check).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INBOUND_DIR = path.join(HERE);

const FORBIDDEN_LABELS = new Set(['client_id', 'instance_id', 'worker']);
const REGISTRATION_RE =
  /registry\.(counter|gauge|histogram)\(\s*(['"`])((?:\\.|(?!\2).)*)\2([^)]*)\)/gs;

interface Registration {
  file: string;
  name: string;
  labels: string[];
}

function collectRegistrations(): Registration[] {
  const registrations: Registration[] = [];
  for (const entry of readdirSync(INBOUND_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.includes('.test.')) {
      continue;
    }
    const filePath = path.join(INBOUND_DIR, entry.name);
    const source = readFileSync(filePath, 'utf8');
    for (const match of source.matchAll(REGISTRATION_RE)) {
      const name = match[3] ?? '';
      const rest = match[4] ?? '';
      const labelsMatch =
        /\[\s*((?:'[^']*'|"[^"]*"|`[^`]*`)(?:\s*,\s*(?:'[^']*'|"[^"]*"|`[^`]*`))*)\s*\]/.exec(rest);
      const labels: string[] = labelsMatch
        ? Array.from(labelsMatch[1]!.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)).map(
            (m) => m[1] ?? m[2] ?? m[3] ?? '',
          )
        : [];
      registrations.push({ file: entry.name, name, labels });
    }
  }
  return registrations;
}

describe('inbound metrics allow-list', () => {
  it('no_inbound_metric_carries_a_client_or_instance_label', () => {
    const registrations = collectRegistrations();

    for (const registration of registrations) {
      for (const label of registration.labels) {
        expect(
          FORBIDDEN_LABELS.has(label),
          `${registration.file}: ${registration.name} carries forbidden label "${label}"`,
        ).toBe(false);
      }
    }

    expect(registrations).toHaveLength(11);
    const files = new Set(registrations.map((r) => r.file));
    expect(files.size).toBeGreaterThanOrEqual(1);

    const registry = createMetricsRegistry();
    expect(() => bindInboundMetrics(registry)).not.toThrow();
  });

  it('bind_is_idempotent_per_registry', () => {
    const registry = createMetricsRegistry();
    const first = bindInboundMetrics(registry);
    const second = bindInboundMetrics(registry);
    expect(second).toBe(first);
  });
});
