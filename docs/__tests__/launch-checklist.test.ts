import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import { describe, expect, it } from 'vitest';
import {
  readMeasuredN,
  scanPublicCapacityClaims,
} from '../../scripts/guards/copy-public-capacity-lib.js';
import { extractBacktickedPaths, parseChecklistRows } from './launch-checklist-parser.js';

/**
 * launch-checklist.test.ts (P29a Unit U5b) - guards `docs/LAUNCH-CHECKLIST.md`
 * itself: every DONE row's evidence path must exist on disk, no capacity or
 * price claim may ship ahead of its gate's evidence, and every NOT DONE row
 * must be named plainly enough to drive the release walkthrough. Pure
 * fs/parsing - no filesystem writes, no `@wp/*` imports.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CHECKLIST_PATH = path.join(REPO_ROOT, 'docs', 'LAUNCH-CHECKLIST.md');

const checklistText = fs.readFileSync(CHECKLIST_PATH, 'utf8');
const rows = parseChecklistRows(checklistText);

describe('launch checklist', () => {
  it('every_launch_gate_row_names_an_evidence_file_that_exists', () => {
    expect(rows.length).toBeGreaterThanOrEqual(25);

    for (const row of rows) {
      expect(row.gate, `row ${row.rowNumber}: Gate cell is blank`).not.toBe('');
      expect(row.status, `row ${row.rowNumber}: Status cell is blank`).not.toBe('');
      expect(row.notes, `row ${row.rowNumber}: Notes cell is blank`).not.toBe('');
      expect(
        ['DONE', 'NOT DONE'],
        `row ${row.rowNumber}: Status must be DONE or NOT DONE, got "${row.status}"`,
      ).toContain(row.status);

      if (row.status === 'DONE') {
        const paths = extractBacktickedPaths(row.evidence);
        expect(
          paths.length,
          `row ${row.rowNumber}: DONE row must name at least one backticked evidence path`,
        ).toBeGreaterThanOrEqual(1);

        const withoutBackticked = row.evidence
          .replace(/`[^`]+`/g, '')
          .replace(/,/g, '')
          .trim();
        expect(
          withoutBackticked,
          `row ${row.rowNumber}: evidence cell has text outside backticks: "${row.evidence}"`,
        ).toBe('');

        for (const evidencePath of paths) {
          const absolute = path.join(REPO_ROOT, evidencePath);
          expect(
            fs.existsSync(absolute),
            `row ${row.rowNumber}: evidence path "${evidencePath}" does not exist`,
          ).toBe(true);
        }
      } else {
        expect(
          row.evidence,
          `row ${row.rowNumber}: NOT DONE row must have evidence exactly "—"`,
        ).toBe('—');
        expect(
          row.notes.length,
          `row ${row.rowNumber}: NOT DONE row must have a non-empty Notes cell`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('no_capacity_or_price_claim_ships_before_its_gate_evidence_exists', () => {
    // (a) Gate B
    const gateBRow = rows.find((row) => row.gate.startsWith('Gate B'));
    expect(gateBRow, 'no row found whose Gate cell starts with "Gate B"').toBeDefined();

    const fleetCapacityDocPath = path.join(REPO_ROOT, 'docs', 'capacity', 'fleet-capacity.md');
    const fleetCapacityDocExists = fs.existsSync(fleetCapacityDocPath);
    const gateBDone = gateBRow?.status === 'DONE';

    if (!gateBDone || !fleetCapacityDocExists) {
      const publicFiles = [
        ...fg.sync(['website/src/**/*'], { cwd: REPO_ROOT, onlyFiles: true }),
        ...fg.sync(['website/content/**/*'], { cwd: REPO_ROOT, onlyFiles: true }),
      ];
      for (const relativePath of publicFiles) {
        const content = fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
        const violations = scanPublicCapacityClaims(
          { path: relativePath.replace(/\\/g, '/'), content },
          undefined,
        );
        expect(
          violations,
          `${relativePath}: capacity claim found while Gate B evidence is missing: ${JSON.stringify(violations)}`,
        ).toHaveLength(0);
      }
    } else {
      // Gate B IS done today: assert the artefact exists and Measured N parses to a finite number.
      expect(fleetCapacityDocExists).toBe(true);
      const fleetCapacityDocText = fs.readFileSync(fleetCapacityDocPath, 'utf8');
      const measuredN = readMeasuredN(fleetCapacityDocText);
      expect(measuredN, 'Measured N marker not found in fleet-capacity.md').toBeDefined();
      const numeric = Number.parseInt((measuredN ?? '').replace(/,/g, ''), 10);
      expect(Number.isFinite(numeric)).toBe(true);
    }

    // (b) Gate C
    const gateCRow = rows.find((row) => row.gate.startsWith('Gate C'));
    expect(gateCRow, 'no row found whose Gate cell starts with "Gate C"').toBeDefined();

    const gateCEvidenceFiles = fg.sync(['docs/evidence/*gate-c*.md'], {
      cwd: REPO_ROOT,
      onlyFiles: true,
      caseSensitiveMatch: false,
    });
    const gateCArtefactExists = gateCEvidenceFiles.length > 0;

    expect(
      gateCRow?.status === 'NOT DONE' || gateCArtefactExists,
      'Gate C row must be NOT DONE unless a docs/evidence/*gate-c*.md artefact exists',
    ).toBe(true);

    if (!gateCArtefactExists) {
      const scannedFiles = [
        ...fg.sync(['website/src/**/*'], { cwd: REPO_ROOT, onlyFiles: true }),
        ...fg.sync(['website/content/**/*'], { cwd: REPO_ROOT, onlyFiles: true }),
        ...fg.sync(['packages/i18n/src/catalogues/**/*'], { cwd: REPO_ROOT, onlyFiles: true }),
        ...fg.sync(['packages/domain/src/copy/**/*'], { cwd: REPO_ROOT, onlyFiles: true }),
        ...fg.sync(['app/frontend/src/**/*'], { cwd: REPO_ROOT, onlyFiles: true }),
        ...fg.sync(['admin/frontend/src/**/*'], { cwd: REPO_ROOT, onlyFiles: true }),
      ].filter(
        (relativePath) =>
          !/\.test\.tsx?$/.test(relativePath) && !relativePath.includes('__fixtures__'),
      );

      const tenThousandTokenPattern = /10,000|10000|ten thousand/i;
      const connectionTokenPattern = /connected|numbers?|sessions?/i;
      const offenders: string[] = [];
      for (const relativePath of scannedFiles) {
        const content = fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
        const lines = content.split('\n');
        lines.forEach((line, index) => {
          if (tenThousandTokenPattern.test(line) && connectionTokenPattern.test(line)) {
            offenders.push(`${relativePath}:${index + 1}`);
          }
        });
      }
      expect(
        offenders,
        `ten-thousand-connected claim found while Gate C is not closed: ${offenders.join(', ')}`,
      ).toHaveLength(0);
    }

    // (c) Price rule
    const priceRow = rows.find((row) => row.gate.startsWith('Real prices'));
    expect(priceRow, 'no row found whose Gate cell starts with "Real prices"').toBeDefined();
    expect(priceRow?.status, 'the "Real prices" row must be DONE').toBe('DONE');

    const pricingCopyPath = path.join(REPO_ROOT, 'website', 'src', 'content', 'copy', 'pricing.ts');
    const pricingCopyText = fs.readFileSync(pricingCopyPath, 'utf8');
    const hasCurrencyFigure = /[₹$]\s?\d/.test(pricingCopyText);

    if (hasCurrencyFigure) {
      expect(priceRow?.notes.toLowerCase()).not.toContain('contact-us');
    } else {
      expect(pricingCopyText).toContain('Prices are shared on request.');
    }
  });

  it('not_done_rows_are_listed_verbatim_for_the_release_walkthrough', () => {
    const notDoneRows = rows.filter((row) => row.status === 'NOT DONE');
    expect(notDoneRows.length).toBeGreaterThan(0);

    for (const row of notDoneRows) {
      expect(
        row.notes.length,
        `row ${row.rowNumber}: NOT DONE row's Notes cell must be at least 20 characters`,
      ).toBeGreaterThanOrEqual(20);
    }

    expect(checklistText).toContain('NOT DONE rows name the blocking fact');
  });
});
