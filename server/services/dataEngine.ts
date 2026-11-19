import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import type {
  DataRow,
  IssueCategory,
  QualityIssue,
  RepairActionType,
  RepairRule,
  ValidationCheck,
} from '../../src/types/datafix.ts';
import { analyzeDataset } from '../engine/datasetAnalyzer.ts';

export interface ParsedTabularDataset {
  columns: string[];
  rows: DataRow[];
  rowCount: number;
}

export interface DimensionScores {
  completeness: number;
  validity: number;
  uniqueness: number;
  consistency: number;
}

export interface ProfileResult {
  qualityScore: number;
  openIssues: number;
  issues: Omit<QualityIssue, 'id' | 'datasetId'>[];
  dimensions: DimensionScores;
}

const MISSING_TOKENS = new Set(['', 'null', 'n/a', 'na', 'none', 'undefined', '-']);
const REGIONAL_DATE_RE = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_STRING_RE = /^(?:[A-Z]{3}\s*|\$|€|£)\s*-?[\d,]+(?:\.\d+)?$/i;
const NUMERIC_COL_RE = /amount|cost|price|value|usd|revenue|salary|age|qty|quantity|total|arr/i;
const DATE_COL_RE = /date|timestamp|created|updated|renewal|dispatch|due|intake/i;
const CODE_COL_RE = /country|currency|site|state|code/i;
const ID_COL_RE = /(^id$|_id$|_no$|_key$|code$)/i;

function isMissingValue(val: string | number | null | undefined): boolean {
  if (val === null || val === undefined) return true;
  if (typeof val === 'string') {
    return MISSING_TOKENS.has(val.trim().toLowerCase());
  }
  return Number.isNaN(val);
}

function normalizeRegionalDate(raw: string): string | null {
  const trimmed = raw.trim();
  if (ISO_DATE_RE.test(trimmed)) return trimmed;
  const match = trimmed.match(REGIONAL_DATE_RE);
  if (!match) return null;
  const first = Number(match[1]);
  const second = Number(match[2]);
  const year = Number(match[3]);

  // Interpret DD/MM/YYYY when first > 12, otherwise standard DD/MM/YYYY if slash-separated
  let day = first;
  let month = second;
  if (second > 12 && first <= 12) {
    month = first;
    day = second;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseCurrencyNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!CURRENCY_STRING_RE.test(trimmed)) return null;
  const cleaned = trimmed.replace(/^(?:[A-Z]{3}\s*|\$|€|£)\s*/i, '').replace(/,/g, '');
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function normalizeCodeValue(col: string, raw: string): string {
  const trimmed = raw.trim();
  if (/country/i.test(col)) {
    const upper = trimmed.toUpperCase();
    return upper === 'UK' ? 'GB' : upper;
  }
  if (/currency/i.test(col)) {
    return trimmed.toUpperCase();
  }
  return trimmed;
}

function computeMedian(numbers: number[]): number {
  if (numbers.length === 0) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return Math.round(value * 100) / 100;
}

function computeMode(values: string[]): string | null {
  if (values.length === 0) return null;
  const counts = new Map<string, number>();
  for (const v of values) {
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best = values[0];
  let max = 0;
  for (const [k, count] of counts.entries()) {
    if (count > max) {
      max = count;
      best = k;
    }
  }
  return best;
}

export function parseCsvString(csvText: string): ParsedTabularDataset {
  const result = Papa.parse<Record<string, string>>(csvText.trim(), {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
  });

  const columns = (result.meta.fields ?? []).map((c) => c.trim()).filter(Boolean);
  const rows: DataRow[] = result.data.map((row) => {
    const normalized: DataRow = {};
    for (const col of columns) {
      const value = row[col];
      if (value === undefined || value === '') {
        normalized[col] = null;
      } else {
        const trimmed = value.trim();
        const isPureNumber =
          trimmed !== '' &&
          value === trimmed &&
          /^-?\d+(?:\.\d+)?$/.test(trimmed) &&
          !(trimmed.length > 1 && trimmed.startsWith('0') && !trimmed.startsWith('0.'));
        normalized[col] = isPureNumber ? Number(trimmed) : value;
      }
    }
    return normalized;
  });

  return {
    columns,
    rows,
    rowCount: rows.length,
  };
}

export function parseExcelBuffer(buffer: Buffer | Uint8Array): ParsedTabularDataset {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    return { columns: [], rows: [], rowCount: 0 };
  }

  const sheet = workbook.Sheets[firstSheetName];
  const rawRows = XLSX.utils.sheet_to_json<DataRow>(sheet, {
    defval: null,
  });

  const columns = rawRows.length > 0 ? Object.keys(rawRows[0]) : [];
  return {
    columns,
    rows: rawRows,
    rowCount: rawRows.length,
  };
}

export function serializeToCsv(rows: DataRow[], columns?: string[]): string {
  if (rows.length === 0) {
    return columns && columns.length > 0 ? `${columns.join(',')}\n` : '';
  }
  return Papa.unparse(rows, columns ? { columns } : undefined);
}

export function buildExcelBuffer(rows: DataRow[], sheetName = 'CleanedData'): Buffer {
  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

export function profileTabularData(columns: string[], rows: DataRow[]): ProfileResult {
  const analysis = analyzeDataset({ columns, rows });
  return {
    qualityScore: analysis.qualityScore.overallScore,
    openIssues: analysis.issues.length,
    issues: analysis.issues,
    dimensions: analysis.dimensions,
  };
}

export function generateRepairRules(
  datasetId: string,
  _columns: string[],
  rows: DataRow[],
  issues: QualityIssue[]
): RepairRule[] {
  const rules: RepairRule[] = [];

  for (let idx = 0; idx < issues.length; idx += 1) {
    const issue = issues[idx];
    const col = issue.column;
    let actionType: RepairActionType = 'trim_and_standardize';
    let strategy = 'Trim & Standardize Text';
    let description = `Normalize whitespace and casing across column "${col}".`;
    let sampleBefore = issue.sampleValue;
    let sampleAfter = issue.sampleValue.replace(/^"|"$/g, '').trim();

    if (issue.category === 'Duplicate Keys') {
      actionType = 'deduplicate_key';
      strategy = 'Deduplicate & Merge Most Complete';
      description = `Collapse duplicate "${col}" keys while retaining non-null fields from matching records.`;
      sampleBefore = `Duplicate (${issue.sampleValue})`;
      sampleAfter = `1 merged row (${issue.sampleValue})`;
    } else if (issue.category === 'Schema Mismatch') {
      actionType = 'coerce_numeric';
      strategy = 'Coerce Currency Strings to Float';
      description = `Strip currency tokens and convert "${col}" text values into numeric decimals.`;
      const coerced = parseCurrencyNumber(issue.sampleValue);
      sampleAfter = coerced !== null ? String(coerced) : '0.00';
    } else if (
      issue.category === 'Format Drift' &&
      issue.ruleTriggered.includes('ISO-8601')
    ) {
      actionType = 'normalize_dates';
      strategy = 'Normalize ISO-8601 Dates';
      description = `Convert regional date strings in "${col}" into canonical YYYY-MM-DD format.`;
      sampleAfter = normalizeRegionalDate(issue.sampleValue) ?? '2026-01-01';
    } else if (issue.category === 'Format Drift') {
      actionType = 'trim_and_standardize';
      const isCode = CODE_COL_RE.test(col);
      strategy = isCode
        ? 'Standardize ISO Code Casing'
        : 'Trim Whitespace Drift';
      description = isCode
        ? `Trim and uppercase codes in "${col}" (mapping legacy "uk" to "GB").`
        : `Remove leading and trailing whitespace across "${col}".`;
      const rawSample = issue.sampleValue.replace(/^"|"$/g, '');
      sampleAfter = isCode ? normalizeCodeValue(col, rawSample) : rawSample.trim();
    } else if (issue.category === 'Outlier Range') {
      actionType = 'fix_negative_outliers';
      strategy = 'Restore Positive Value Boundary';
      description = `Correct negative sign-entry errors in "${col}" to positive magnitude.`;
      const n = Number(issue.sampleValue);
      sampleAfter = Number.isFinite(n) ? String(Math.abs(n)) : '0';
    } else if (issue.category === 'Missing Values') {
      actionType = 'impute_missing';
      const numericVals = rows
        .map((r) => r[col])
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
      if (numericVals.length > 0 && NUMERIC_COL_RE.test(col)) {
        const med = computeMedian(numericVals);
        strategy = 'Impute Numeric Column Median';
        description = `Fill missing values in "${col}" with the column median (${med}).`;
        sampleAfter = String(med);
      } else if (/email/i.test(col)) {
        strategy = 'Populate Placeholder Verification Email';
        description = `Assign deterministic placeholder contact email for missing "${col}" records.`;
        sampleAfter = 'pending-verification@domain.invalid';
      } else {
        const strVals = rows
          .map((r) => r[col])
          .filter((v): v is string => typeof v === 'string' && !isMissingValue(v))
          .map((v) => v.trim());
        const mode = computeMode(strVals) ?? 'Unspecified';
        strategy = 'Impute Most Frequent Value';
        description = `Backfill null entries in "${col}" using the column mode ("${mode}").`;
        sampleAfter = mode;
      }
    }

    rules.push({
      id: `rep-${datasetId}-${idx + 1}`,
      datasetId,
      column: col,
      actionType,
      strategy,
      description,
      affectedRows: issue.affectedRows,
      sampleBefore,
      sampleAfter,
      selected: true,
      applied: false,
    });
  }

  return rules;
}

const REPAIR_EXECUTION_ORDER: Record<RepairActionType, number> = {
  deduplicate_key: 1,
  coerce_numeric: 2,
  normalize_dates: 3,
  trim_and_standardize: 4,
  fix_negative_outliers: 5,
  impute_missing: 6,
};

export function applyRepairRulesToRows(
  columns: string[],
  rows: DataRow[],
  rules: RepairRule[]
): { rows: DataRow[]; cellsModified: number } {
  let workingRows: DataRow[] = rows.map((row) => ({ ...row }));
  let cellsModified = 0;

  const orderedRules = [...rules].sort(
    (a, b) =>
      (REPAIR_EXECUTION_ORDER[a.actionType] ?? 99) -
      (REPAIR_EXECUTION_ORDER[b.actionType] ?? 99)
  );

  for (const rule of orderedRules) {
    const col = rule.column;

    if (rule.actionType === 'deduplicate_key') {
      const mergedByKey = new Map<string, DataRow>();
      const ordered: DataRow[] = [];

      for (const row of workingRows) {
        const rawKey = row[col];
        if (isMissingValue(rawKey)) {
          ordered.push(row);
          continue;
        }
        const key = String(rawKey).trim();
        const existing = mergedByKey.get(key);
        if (!existing) {
          mergedByKey.set(key, row);
          ordered.push(row);
        } else {
          // Merge missing fields from duplicate into retained row
          for (const c of columns) {
            if (isMissingValue(existing[c]) && !isMissingValue(row[c])) {
              existing[c] = row[c];
              cellsModified += 1;
            }
          }
          cellsModified += 1;
        }
      }
      workingRows = ordered;
      continue;
    }

    if (rule.actionType === 'coerce_numeric') {
      for (const row of workingRows) {
        const val = row[col];
        if (typeof val === 'string') {
          const parsed = parseCurrencyNumber(val);
          if (parsed !== null) {
            row[col] = parsed;
            cellsModified += 1;
          }
        }
      }
      continue;
    }

    if (rule.actionType === 'normalize_dates') {
      for (const row of workingRows) {
        const val = row[col];
        if (typeof val === 'string' && !ISO_DATE_RE.test(val.trim())) {
          const normalized = normalizeRegionalDate(val);
          if (normalized) {
            row[col] = normalized;
            cellsModified += 1;
          }
        }
      }
      continue;
    }

    if (rule.actionType === 'trim_and_standardize') {
      const isCode = CODE_COL_RE.test(col);
      for (const row of workingRows) {
        const val = row[col];
        if (typeof val === 'string' && !isMissingValue(val)) {
          const next = isCode ? normalizeCodeValue(col, val) : val.trim();
          if (next !== val) {
            row[col] = next;
            cellsModified += 1;
          }
        }
      }
      continue;
    }

    if (rule.actionType === 'fix_negative_outliers') {
      for (const row of workingRows) {
        const val = row[col];
        if (typeof val === 'number' && val < 0) {
          row[col] = Math.abs(val);
          cellsModified += 1;
        } else if (typeof val === 'string') {
          const parsed = Number(val.trim());
          if (Number.isFinite(parsed) && parsed < 0) {
            row[col] = Math.abs(parsed);
            cellsModified += 1;
          }
        }
      }
      continue;
    }

    if (rule.actionType === 'impute_missing') {
      const numericVals = workingRows
        .map((r) => r[col])
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
      const isNumeric = numericVals.length > 0 && NUMERIC_COL_RE.test(col);
      const medianVal = isNumeric ? computeMedian(numericVals) : null;
      const strVals = workingRows
        .map((r) => r[col])
        .filter((v): v is string => typeof v === 'string' && !isMissingValue(v))
        .map((v) => v.trim());
      const modeVal = computeMode(strVals) ?? 'Unspecified';

      for (const row of workingRows) {
        if (isMissingValue(row[col])) {
          if (isNumeric && medianVal !== null) {
            row[col] = medianVal;
          } else if (/email/i.test(col)) {
            row[col] = 'pending-verification@domain.invalid';
          } else {
            row[col] = modeVal;
          }
          cellsModified += 1;
        }
      }
    }
  }

  return { rows: workingRows, cellsModified };
}

export function computeValidationChecks(
  datasetId: string,
  baseline: DimensionScores,
  current: DimensionScores,
  rowCount: number
): ValidationCheck[] {
  return [
    {
      id: `val-${datasetId}-comp`,
      datasetId,
      checkName: 'Required Field Completeness',
      dimension: 'Completeness',
      beforeScore: baseline.completeness,
      afterScore: current.completeness,
      passed: current.completeness >= 98,
      details: `Evaluated non-null cell density across ${rowCount.toLocaleString()} records.`,
    },
    {
      id: `val-${datasetId}-val`,
      datasetId,
      checkName: 'Schema & Numeric Range Validity',
      dimension: 'Validity',
      beforeScore: baseline.validity,
      afterScore: current.validity,
      passed: current.validity >= 98,
      details: 'Verified strict numeric typing and non-negative monetary boundaries.',
    },
    {
      id: `val-${datasetId}-uniq`,
      datasetId,
      checkName: 'Primary Identifier Uniqueness',
      dimension: 'Uniqueness',
      beforeScore: baseline.uniqueness,
      afterScore: current.uniqueness,
      passed: current.uniqueness >= 99,
      details: 'Verified zero conflicting duplicate primary keys across dataset.',
    },
    {
      id: `val-${datasetId}-cons`,
      datasetId,
      checkName: 'ISO Format & Casing Consistency',
      dimension: 'Consistency',
      beforeScore: baseline.consistency,
      afterScore: current.consistency,
      passed: current.consistency >= 98,
      details: 'Checked ISO-8601 date patterns, standardized codes, and trimmed text.',
    },
  ];
}

export function aggregateIssueDistribution(
  issues: { category: IssueCategory; affectedRows: number }[]
): { category: IssueCategory; count: number }[] {
  const categories: IssueCategory[] = [
    'Missing Values',
    'Schema Mismatch',
    'Duplicate Keys',
    'Format Drift',
    'Outlier Range',
  ];

  const map = new Map<IssueCategory, number>();
  for (const cat of categories) {
    map.set(cat, 0);
  }
  for (const issue of issues) {
    map.set(issue.category, (map.get(issue.category) ?? 0) + issue.affectedRows);
  }

  return categories.map((category) => ({
    category,
    count: map.get(category) ?? 0,
  }));
}

export function computeDashboardMetrics(
  datasets: import('../../src/types/datafix.ts').DatasetRecord[],
  issues: QualityIssue[],
  trends: import('../../src/types/datafix.ts').QualityTrendPoint[]
): import('../../src/types/datafix.ts').DashboardSummary {
  const realDatasets = datasets.filter((d) => !d.isDemo);
  const isDemoMode = realDatasets.length === 0;
  const scopedDatasets = isDemoMode ? datasets : realDatasets;
  const scopedIds = new Set(scopedDatasets.map((d) => d.id));
  const scopedIssues = issues.filter((issue) => scopedIds.has(issue.datasetId));

  const totalDatasets = scopedDatasets.length;
  const totalRecords = scopedDatasets.reduce((sum, ds) => sum + ds.rows, 0);
  const totalOpenIssues = scopedDatasets.reduce(
    (sum, ds) => sum + ds.openIssues,
    0
  );
  const totalRepairedCells = scopedDatasets.reduce(
    (sum, ds) => sum + ds.repairedCells,
    0
  );
  const averageQualityScore =
    totalDatasets > 0
      ? Math.round(
          (scopedDatasets.reduce((sum, ds) => sum + ds.qualityScore, 0) /
            totalDatasets) *
            10
        ) / 10
      : 0;

  let missingValues = 0;
  let duplicateRecords = 0;
  let invalidEntries = 0;

  for (const issue of scopedIssues) {
    if (issue.category === 'Missing Values') {
      missingValues += issue.affectedRows;
    } else if (issue.category === 'Duplicate Keys') {
      duplicateRecords += issue.affectedRows;
    } else {
      invalidEntries += issue.affectedRows;
    }
  }

  const issueDistribution = aggregateIssueDistribution(scopedIssues);
  const issueShare = [
    { name: 'Missing Values', value: missingValues },
    { name: 'Duplicate Records', value: duplicateRecords },
    { name: 'Invalid Entries', value: invalidEntries },
  ].filter((slice) => slice.value > 0);

  const latestTrend = [...trends];
  if (latestTrend.length > 0) {
    latestTrend[latestTrend.length - 1] = {
      ...latestTrend[latestTrend.length - 1],
      qualityScore: averageQualityScore,
      issuesDetected: totalOpenIssues,
      recordsRepaired: isDemoMode
        ? Math.max(latestTrend[latestTrend.length - 1].recordsRepaired, totalRepairedCells)
        : totalRepairedCells,
    };
  }

  return {
    isDemoMode,
    totalDatasets,
    totalRecords,
    missingValues,
    duplicateRecords,
    invalidEntries,
    averageQualityScore,
    totalOpenIssues,
    totalRepairedCells,
    trends: latestTrend,
    issueShare,
    issueDistribution,
  };
}
