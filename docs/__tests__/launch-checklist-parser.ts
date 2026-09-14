/**
 * launch-checklist-parser.ts (P29a E3/C2 hardening) - the LAUNCH-CHECKLIST.md
 * markdown-table parser, extracted from launch-checklist.test.ts so a sibling
 * edge-case test (launch-checklist-parser-edge.test.ts) can exercise it on
 * synthetic table strings without duplicating the parsing logic. Pure
 * string parsing only - no fs, no `@wp/*` imports.
 */

export interface ChecklistRow {
  rowNumber: number;
  gate: string;
  status: string;
  evidence: string;
  notes: string;
}

/** Splits a markdown table row `| a | b | c | d | e |` into trimmed cells, ignoring the outer empties. */
export function splitRow(line: string): string[] {
  const trimmed = line.trim();
  const withoutEdges = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return withoutEdges.split('|').map((cell) => cell.trim());
}

/** Parses the checklist's single markdown table into rows, skipping the header and separator lines. */
export function parseChecklistRows(text: string): ChecklistRow[] {
  const rows: ChecklistRow[] = [];
  const lines = text.split('\n');
  for (const line of lines) {
    if (!line.trim().startsWith('|')) continue;
    const cells = splitRow(line);
    if (cells.length < 5) continue;
    const firstCell = cells[0] ?? '';
    if (firstCell === '#') continue; // header
    if (/^-+$/.test(firstCell)) continue; // separator row
    const rowNumber = Number.parseInt(firstCell, 10);
    if (!Number.isFinite(rowNumber)) continue;
    rows.push({
      rowNumber,
      gate: cells[1] ?? '',
      status: cells[2] ?? '',
      evidence: cells[3] ?? '',
      notes: cells[4] ?? '',
    });
  }
  return rows;
}

/** Extracts every backticked path in a cell, in order. */
export function extractBacktickedPaths(cell: string): string[] {
  const matches = [...cell.matchAll(/`([^`]+)`/g)];
  return matches.map((match) => match[1] ?? '');
}
