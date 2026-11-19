import type { IssueSeverity } from '../../src/types/datafix.ts';
import type {
  FlaggedCellOccurrence,
  MissingValueColumnReport,
  MissingValueReport,
  TabularCell,
  TabularRow,
} from './types.ts';

const MISSING_TOKENS = new Set(['', 'null', 'n/a', 'na', 'none', 'undefined', '-']);

export function isCellMissing(val: TabularCell | undefined): boolean {
  if (val === null || val === undefined) return true;
  if (typeof val === 'string') {
    return MISSING_TOKENS.has(val.trim().toLowerCase());
  }
  return Number.isNaN(val);
}

function formatMissingOriginalValue(val: TabularCell | undefined): string {
  if (val === null || val === undefined) return '(empty)';
  if (typeof val === 'string') {
    const trimmed = val.trim();
    return trimmed === '' ? '(empty)' : val;
  }
  return String(val);
}

/**
 * Detects missing, null, blank, or sentinel placeholder values across all columns.
 * Pure function — does not mutate input rows.
 */
export function detectMissingValues(
  columns: readonly string[],
  rows: ReadonlyArray<Readonly<TabularRow>>
): MissingValueReport {
  if (columns.length === 0 || rows.length === 0) {
    return {
      totalMissingCells: 0,
      affectedRowCount: 0,
      missingRatePercent: 0,
      byColumn: [],
    };
  }

  const byColumn: MissingValueColumnReport[] = [];
  const affectedRows = new Set<number>();
  let totalMissingCells = 0;

  for (const col of columns) {
    const rowIndices: number[] = [];
    const cells: FlaggedCellOccurrence[] = [];

    for (let i = 0; i < rows.length; i += 1) {
      const val = rows[i][col];
      if (isCellMissing(val)) {
        rowIndices.push(i);
        affectedRows.add(i);
        cells.push({
          rowIndex: i,
          originalValue: formatMissingOriginalValue(val),
        });
      }
    }

    if (rowIndices.length > 0) {
      totalMissingCells += rowIndices.length;
      const missingPercent =
        Math.round((rowIndices.length / rows.length) * 1000) / 10;
      const severity: IssueSeverity =
        rowIndices.length / rows.length >= 0.15 ? 'Critical' : 'Warning';

      byColumn.push({
        column: col,
        missingCount: rowIndices.length,
        missingPercent,
        rowIndices,
        cells,
        severity,
        sampleValue: cells[0]?.originalValue ?? '(empty)',
        ruleTriggered: 'Non-null completeness check',
      });
    }
  }

  const totalCells = columns.length * rows.length;
  const missingRatePercent =
    totalCells > 0 ? Math.round((totalMissingCells / totalCells) * 1000) / 10 : 0;

  return {
    totalMissingCells,
    affectedRowCount: affectedRows.size,
    missingRatePercent,
    byColumn,
  };
}
