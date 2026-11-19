import { isCellMissing } from './missingValueDetector.ts';
import type {
  DuplicateKeyGroup,
  DuplicateReport,
  ExactDuplicateMatch,
  TabularRow,
} from './types.ts';

const PRIMARY_ID_COL_RE = /(^id$|_id$|_no$|_key$|^sku$|^invoice_?num(?:ber)?$|^order_?num(?:ber)?$|^record_?code$|^item_?code$|^product_?code$)/i;
const NON_UNIQUE_CODE_COL_RE = /(country_?code|currency_?code|zip_?code|postal_?code|area_?code|state_?code|status_?code|dept_?code|region_?code|lang_?code)/i;

function summarizeRow(columns: readonly string[], row: Readonly<TabularRow>): string {
  const previewParts: string[] = [];
  for (const col of columns.slice(0, 3)) {
    const val = row[col];
    if (!isCellMissing(val)) {
      previewParts.push(String(val).trim());
    }
  }
  return previewParts.length > 0 ? previewParts.join(' · ') : '(duplicate row)';
}

/**
 * Detects both completely duplicated rows (exact full-row duplicates)
 * and conflicting duplicate primary/entity keys.
 * Pure function — does not mutate input rows.
 */
export function detectDuplicates(
  columns: readonly string[],
  rows: ReadonlyArray<Readonly<TabularRow>>
): DuplicateReport {
  if (columns.length === 0 || rows.length === 0) {
    return {
      totalDuplicateRows: 0,
      exactDuplicateCount: 0,
      exactDuplicateRowIndices: [],
      exactDuplicateMatches: [],
      keyColumn: null,
      keyDuplicateCount: 0,
      keyDuplicateRowIndices: [],
      duplicateKeys: [],
    };
  }

  // 1. Completely duplicated rows (all columns identical)
  const firstRowBySignature = new Map<string, number>();
  const exactDuplicateRowIndices: number[] = [];
  const exactDuplicateMatches: ExactDuplicateMatch[] = [];

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const sig = columns
      .map((col) => {
        const val = row[col];
        return isCellMissing(val) ? '__NULL__' : String(val).trim();
      })
      .join('\u001F');

    const firstIdx = firstRowBySignature.get(sig);
    if (firstIdx !== undefined) {
      exactDuplicateRowIndices.push(i);
      exactDuplicateMatches.push({
        rowIndex: i,
        firstRowIndex: firstIdx,
        originalValue: summarizeRow(columns, row),
      });
    } else {
      firstRowBySignature.set(sig, i);
    }
  }

  // 2. Primary key / entity identifier duplicates (prefer column 0 if ID-like, otherwise first high-uniqueness ID column)
  const keyColumn =
    columns.find((col, idx) => {
      if (NON_UNIQUE_CODE_COL_RE.test(col) || !PRIMARY_ID_COL_RE.test(col)) {
        return false;
      }
      if (idx === 0) return true;
      const seen = new Set<string>();
      let nonNull = 0;
      for (const row of rows) {
        const v = row[col];
        if (!isCellMissing(v)) {
          nonNull += 1;
          seen.add(String(v).trim());
        }
      }
      // Require >= 50% distinctness for non-first ID columns so foreign keys / category IDs don't false-positive
      return nonNull >= 2 && seen.size / nonNull >= 0.5;
    }) ?? null;
  const keyDuplicateRowIndices: number[] = [];
  const duplicateKeys: DuplicateKeyGroup[] = [];

  if (keyColumn) {
    const occurrencesByKey = new Map<string, number[]>();
    for (let i = 0; i < rows.length; i += 1) {
      const rawKey = rows[i][keyColumn];
      if (isCellMissing(rawKey)) continue;
      const key = String(rawKey).trim();
      const list = occurrencesByKey.get(key) ?? [];
      list.push(i);
      occurrencesByKey.set(key, list);
    }

    for (const [keyValue, indices] of occurrencesByKey.entries()) {
      if (indices.length > 1) {
        duplicateKeys.push({
          column: keyColumn,
          keyValue,
          rowIndices: indices,
          occurrences: indices.length,
        });
        for (let j = 1; j < indices.length; j += 1) {
          keyDuplicateRowIndices.push(indices[j]);
        }
      }
    }
  }

  const combinedDuplicateSet = new Set<number>([
    ...exactDuplicateRowIndices,
    ...keyDuplicateRowIndices,
  ]);

  return {
    totalDuplicateRows: combinedDuplicateSet.size,
    exactDuplicateCount: exactDuplicateRowIndices.length,
    exactDuplicateRowIndices,
    exactDuplicateMatches,
    keyColumn,
    keyDuplicateCount: keyDuplicateRowIndices.length,
    keyDuplicateRowIndices,
    duplicateKeys,
  };
}
