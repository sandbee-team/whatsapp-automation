import {
  ADR_0018_TIER_CLAIM,
  INTERNAL_BANNER,
  type RestoreDrillReport,
} from './restore-drill-report-types.js';

/**
 * scripts/ops/restore-drill-report-markdown.ts (P29a Unit U3, step 9) - the
 * markdown formatter, split out of `restore-drill-report.ts` purely for the
 * repo's `max-lines` cap (that file sat at exactly 300 lines before this
 * phase's v2 schema fields; same code-motion-split idiom as
 * `session-worker-discovery-wiring.ts`). No new module boundary - this file
 * and `restore-drill-report.ts` share one contract.
 *
 * `RestoreDrillReport`'s v2 fields (`restore.mode`, `verification.parity`,
 * `verification.ledgerChain`, `recovery`, `rto`) are typed OPTIONAL on the
 * shared interface so a v1 report still validates - but the formatter only
 * ever receives a report this phase's own tooling produced, which always
 * populates them, so `FormattableRestoreDrillReport` requires them here
 * (never silently prints "undefined" for a v2 report missing a v2 field).
 */
export type FormattableRestoreDrillReport = RestoreDrillReport &
  Required<Pick<RestoreDrillReport, 'recovery' | 'rto'>> & {
    restore: RestoreDrillReport['restore'] & {
      mode: NonNullable<RestoreDrillReport['restore']['mode']>;
    };
    verification: RestoreDrillReport['verification'] &
      Required<Pick<RestoreDrillReport['verification'], 'parity' | 'ledgerChain'>>;
  };

function formatTableRows(tables: RestoreDrillReport['verification']['tables']): string {
  const header = '| table | source rows | restored rows | match |\n| --- | ---: | ---: | --- |';
  const rows = tables.map((t) => {
    const match = t.sourceRows === t.restoredRows ? 'yes' : 'MISMATCH';
    return `| ${t.name} | ${String(t.sourceRows)} | ${String(t.restoredRows)} | ${match} |`;
  });
  return [header, ...rows].join('\n');
}

function formatMmSs(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatParityRows(
  parity: NonNullable<RestoreDrillReport['verification']['parity']>,
): string {
  const header = '| table | source rows | restored rows | exists |\n| --- | ---: | ---: | --- |';
  const rows = parity.map((p) => {
    const exists = p.exists ? 'yes' : 'no (not in v1)';
    return `| ${p.name} | ${String(p.sourceRows)} | ${String(p.restoredRows)} | ${exists} |`;
  });
  return [header, ...rows].join('\n');
}

/**
 * Formats `report` as a markdown document. The measured RTO is placed
 * DIRECTLY next to the ADR 0018 §7 tier claim line (never on a separate
 * page/section) so agreement or disagreement is stated, never smoothed over.
 * Same placement discipline for the measured RPO, next to its own 5-minute
 * target. Never prints a password or a credential-bearing `postgres://` URL.
 */
export function formatRestoreDrillMarkdown(report: FormattableRestoreDrillReport): string {
  const rto = formatMmSs(report.restore.tookMs);
  const rpoMinutes = (report.recovery.rpoSeconds / 60).toFixed(1);
  const rpoTargetMinutes = (report.recovery.rpoTargetSeconds / 60).toFixed(0);
  const lines: string[] = [
    `# Restore drill - ${report.capturedAtIso}`,
    '',
    INTERNAL_BANNER,
    '',
    `Mode: ${report.restore.mode}`,
    '',
    `Measured RTO: ${rto} at ${String(report.restore.dataSizeBytes)} bytes — ADR 0018 §7 claims ${ADR_0018_TIER_CLAIM}; tier ${report.adr0018Tier.tier} claims "${report.adr0018Tier.claimedRto}".`,
    '',
    `Measured RPO: ${String(report.recovery.rpoSeconds)}s (${rpoMinutes} min) against a ${rpoTargetMinutes}-minute target; recovery point ${report.recovery.recoveryPointIso}; ok=${String(report.recovery.ok)}.`,
    '',
    `Ledger chain: ${String(report.verification.ledgerChain.clientsChecked)} clients, ${String(report.verification.ledgerChain.rowsChecked)} rows, ${String(report.verification.ledgerChain.breaks)} break(s); ok=${String(report.verification.ledgerChain.ok)}.`,
    '',
    // ADR 0018 §8 / Gate-B clause (e): the page names the 10,000 tier, so it must carry the honest marker.
    'Capacity note (ADR 0018 §8): this drill measures restore time only; fleet capacity has been measured to the N stated in docs/capacity/fleet-capacity.md, and no figure on this page is a capacity claim.',
    '',
    `Verdict: ${report.verdict}`,
    '',
    '## Source / target',
    '',
    `- Source: ${report.source.host}/${report.source.database} (schema version ${String(report.source.schemaVersion)})`,
    `- Target: ${report.restore.target.host}/${report.restore.target.database}`,
    '',
    '## Backup',
    '',
    `- Tool: ${report.backup.tool} (format=${report.backup.format}, compression=${report.backup.compression})`,
    `- Took: ${String(report.backup.tookMs)} ms, ${String(report.backup.bytes)} bytes`,
    `- Dump path: ${report.backup.path}`,
    '',
    '## Restore',
    '',
    `- Took: ${String(report.restore.tookMs)} ms (${rto})`,
    `- Source data size: ${String(report.restore.dataSizeBytes)} bytes`,
    `- Restored data size: ${String(report.restore.restoredDataSizeBytes)} bytes`,
    '',
    '## Schema version',
    '',
    `- Expected: ${String(report.verification.schemaVersion.expected)}, actual: ${String(report.verification.schemaVersion.actual)}, ok: ${String(report.verification.schemaVersion.ok)}`,
    '',
    '## Table row counts (all public tables)',
    '',
    formatTableRows(report.verification.tables),
    '',
    '## Named-table parity',
    '',
    formatParityRows(report.verification.parity),
    '',
    '## Claim query',
    '',
    `- Rows returned: ${String(report.verification.claimQuery.rowsReturned)}, ok: ${String(report.verification.claimQuery.ok)}`,
    `- Note: ${report.verification.claimQuery.note}`,
    '',
    '## Plaintext scan',
    '',
    `- Sentinels: ${report.verification.plaintextScan.sentinels.join(', ')}`,
    `- Blob hits: ${String(report.verification.plaintextScan.blobHits)}, dump file hits: ${String(report.verification.plaintextScan.dumpFileHits)}, ok: ${String(report.verification.plaintextScan.ok)}`,
    '',
    '## Problems',
    '',
    report.problems.length > 0 ? report.problems.map((p) => `- ${p}`).join('\n') : '(none)',
    '',
    '## Notes',
    '',
    report.notes.length > 0 ? report.notes.map((n) => `- ${n}`).join('\n') : '(none)',
    '',
  ];
  return lines.join('\n');
}
