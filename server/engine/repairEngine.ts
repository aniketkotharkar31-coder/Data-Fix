import type {
  ApproveRepairSelection,
  DataRow,
  DetectedIssueRecord,
  ModificationHistoryEntry,
  RepairConfidenceLevel,
  RepairSuggestion,
} from '../../src/types/datafix.ts';
import type { DatasetAnalysisResult } from './types.ts';

const MISSING_TOKENS = new Set([
  '',
  'null',
  'n/a',
  'na',
  'none',
  'undefined',
  '-',
  'nan',
]);

const PERSONAL_OR_IDENTIFIER_COL_RE =
  /(^id$|_id$|_no$|_key$|email|e_mail|mail|phone|mobile|tel|contact|full_?name|first_?name|last_?name|customer_?name|account_?name|vendor_?name|patient|person|address|street|ssn|sin|tax_?id|national_?id|passport|license|dob|birth|iban|card)/i;

const NON_NUMERIC_CODE_COL_RE = /(phone|mobile|tel|zip|postal|pin|ssn|id$|_id$|_no$|code$)/i;
const EXPLICIT_NUMERIC_COL_RE = /amount|cost|price|value|usd|revenue|salary|age|qty|quantity|total|arr/i;
const CURRENCY_STRING_RE =
  /^(?:-?\s*(?:[A-Z]{3}\s*|\$|€|£|₹)\s*|(?:[A-Z]{3}\s*|\$|€|£|₹)\s*-?)[\d,]+(?:\.\d+)?$/i;
const REGIONAL_DATE_RE = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/;
const SLASH_YMD_DATE_RE = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isMissingCell(val: string | number | null | undefined): boolean {
  if (val === null || val === undefined) return true;
  if (typeof val === 'number') return Number.isNaN(val);
  return MISSING_TOKENS.has(val.trim().toLowerCase());
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (year < 1900 || year > 2150 || month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

function normalizeValidRegionalDate(raw: string): string | null {
  const trimmed = raw.trim();
  if (ISO_DATE_RE.test(trimmed)) {
    const [y, m, d] = trimmed.split('-').map(Number);
    return isValidCalendarDate(y, m, d) ? trimmed : null;
  }
  const slashYmd = trimmed.match(SLASH_YMD_DATE_RE);
  if (slashYmd) {
    const year = Number(slashYmd[1]);
    const month = Number(slashYmd[2]);
    const day = Number(slashYmd[3]);
    if (!isValidCalendarDate(year, month, day)) return null;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  const match = trimmed.match(REGIONAL_DATE_RE);
  if (!match) return null;
  const first = Number(match[1]);
  const second = Number(match[2]);
  const year = Number(match[3]);
  let day = first;
  let month = second;
  if (second > 12 && first <= 12) {
    month = first;
    day = second;
  }
  if (!isValidCalendarDate(year, month, day)) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseCurrencyToNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!CURRENCY_STRING_RE.test(trimmed)) return null;
  const isNegative =
    trimmed.startsWith('-') || /^(?:[A-Z]{3}\s*|\$|€|£|₹)\s*-/i.test(trimmed);
  const cleaned = trimmed
    .replace(/^-?\s*(?:[A-Z]{3}\s*|\$|€|£|₹)\s*-?\s*/i, '')
    .replace(/,/g, '');
  const num = Number(cleaned);
  if (!Number.isFinite(num)) return null;
  const signed = isNegative ? -Math.abs(num) : num;
  return Math.round(signed * 100) / 100;
}

function roundStat(value: number): number {
  return Math.round(value * 100) / 100;
}

function computeNumericColumnStats(
  rows: readonly DataRow[],
  column: string
): { mean: number; median: number; sampleSize: number; isSkewed: boolean } | null {
  if (NON_NUMERIC_CODE_COL_RE.test(column)) return null;

  const nums: number[] = [];
  let nonMissingCount = 0;

  for (const row of rows) {
    const val = row[column];
    if (isMissingCell(val)) continue;
    nonMissingCount += 1;
    if (typeof val === 'number' && Number.isFinite(val)) {
      nums.push(val);
    } else if (typeof val === 'string') {
      const trimmed = val.trim();
      if (/^-?\d{1,3}(?:,\d{3})*(?:\.\d+)?$|^-?\d+(?:\.\d+)?$/.test(trimmed)) {
        const parsed = Number(trimmed.replace(/,/g, ''));
        if (Number.isFinite(parsed)) nums.push(parsed);
      } else {
        const curr = parseCurrencyToNumber(trimmed);
        if (curr !== null) nums.push(curr);
      }
    }
  }

  // Require at least 2 observed numeric values and >= 80% numeric dominance
  if (nums.length < 2 || nonMissingCount === 0 || nums.length / nonMissingCount < 0.8) {
    return null;
  }

  const sorted = [...nums].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, n) => acc + n, 0);
  const mean = roundStat(sum / sorted.length);
  const mid = Math.floor(sorted.length / 2);
  const median = roundStat(
    sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid]
  );

  // Use median by default when mean deviates noticeably from median (skewed/outliers)
  const isSkewed = median !== 0 && Math.abs(mean - median) / Math.abs(median) > 0.15;

  return { mean, median, sampleSize: sorted.length, isSkewed };
}

function computeCategoricalColumnMode(
  rows: readonly DataRow[],
  column: string
): { mode: string; frequency: number; totalObserved: number } | null {
  const counts = new Map<string, number>();
  let totalObserved = 0;

  for (const row of rows) {
    const val = row[column];
    if (isMissingCell(val)) continue;
    const cleaned = String(val).trim();
    if (!cleaned) continue;
    totalObserved += 1;
    counts.set(cleaned, (counts.get(cleaned) ?? 0) + 1);
  }

  if (totalObserved < 2 || counts.size === 0) return null;

  // Reject high-cardinality free-text columns where every value is unique (don't invent data)
  let bestVal = '';
  let bestCount = 0;
  for (const [val, count] of counts.entries()) {
    if (count > bestCount) {
      bestCount = count;
      bestVal = val;
    }
  }

  if (bestCount < 2) return null;

  return {
    mode: bestVal,
    frequency: bestCount,
    totalObserved,
  };
}

function extractCanonicalTargetFromAction(action: string): string | null {
  // Matches: Standardize value to "Bengaluru"., Standardize code to "GB"., Standardize casing to "Active"., Trim whitespace to "Solaris Biotech".
  const match = action.match(/(?:to|with)\s+"([^"]+)"/i);
  return match ? match[1] : null;
}

function extractDuplicateReferenceRow(description: string): number | undefined {
  const match = description.match(/Row\s+(\d+)\.?$/i);
  if (match) return Number(match[1]);
  const alt = description.match(/first seen at Row\s+(\d+)/i);
  if (alt) return Number(alt[1]);
  return undefined;
}

function buildSuggestionForIssue(
  datasetId: string,
  datasetName: string,
  issue: DetectedIssueRecord,
  rows: readonly DataRow[],
  index: number
): RepairSuggestion {
  const baseId = `rsug-${datasetId}-${index + 1}`;

  // 1. MISSING VALUES
  if (issue.issueType === 'Missing Values') {
    // Strictly never invent missing personal or unique identifier information
    if (PERSONAL_OR_IDENTIFIER_COL_RE.test(issue.column)) {
      return {
        id: baseId,
        datasetId,
        datasetName,
        issueId: issue.id,
        issueType: 'Missing Values',
        column: issue.column,
        rowNumber: issue.rowNumber,
        originalValue: issue.originalValue,
        proposedValue: 'Manual Review Required',
        proposedRawValue: null,
        reason: `Personal or identifier column "${issue.column}" cannot be imputed without inventing unverified information.`,
        repairMethod: 'Manual Review (No Fabrication)',
        operationType: 'manual_review',
        confidenceLevel: 'Low',
        manualReviewOnly: true,
      };
    }

    const numericStats = computeNumericColumnStats(rows, issue.column);
    if (numericStats) {
      const defaultMethod: 'mean' | 'median' = numericStats.isSkewed ? 'median' : 'mean';
      const defaultVal =
        defaultMethod === 'median' ? numericStats.median : numericStats.mean;
      return {
        id: baseId,
        datasetId,
        datasetName,
        issueId: issue.id,
        issueType: 'Missing Values',
        column: issue.column,
        rowNumber: issue.rowNumber,
        originalValue: issue.originalValue,
        proposedValue: String(defaultVal),
        proposedRawValue: defaultVal,
        reason: `Missing numeric value in "${issue.column}". Computed from ${numericStats.sampleSize} observed records (Mean: ${numericStats.mean}, Median: ${numericStats.median}).`,
        repairMethod:
          defaultMethod === 'median' ? 'Median Imputation' : 'Mean Imputation',
        operationType: 'impute_numeric_missing',
        confidenceLevel: numericStats.sampleSize >= 4 ? 'Medium' : 'Low',
        manualReviewOnly: false,
        imputationOptions: {
          meanValue: numericStats.mean,
          medianValue: numericStats.median,
          defaultMethod,
          sampleSize: numericStats.sampleSize,
        },
      };
    }

    if (!EXPLICIT_NUMERIC_COL_RE.test(issue.column)) {
      const modeStats = computeCategoricalColumnMode(rows, issue.column);
      if (modeStats) {
        const sharePct = Math.round((modeStats.frequency / modeStats.totalObserved) * 100);
        return {
          id: baseId,
          datasetId,
          datasetName,
          issueId: issue.id,
          issueType: 'Missing Values',
          column: issue.column,
          rowNumber: issue.rowNumber,
          originalValue: issue.originalValue,
          proposedValue: modeStats.mode,
          proposedRawValue: modeStats.mode,
          reason: `Missing categorical entry in "${issue.column}". Mode "${modeStats.mode}" appears in ${modeStats.frequency} of ${modeStats.totalObserved} observed rows (${sharePct}%).`,
          repairMethod: 'Mode Imputation',
          operationType: 'impute_categorical_missing',
          confidenceLevel: sharePct >= 60 ? 'Medium' : 'Low',
          manualReviewOnly: false,
        };
      }
    }

    // No recurring mode and not numeric — do NOT invent missing information
    return {
      id: baseId,
      datasetId,
      datasetName,
      issueId: issue.id,
      issueType: 'Missing Values',
      column: issue.column,
      rowNumber: issue.rowNumber,
      originalValue: issue.originalValue,
      proposedValue: 'Manual Review Required',
      proposedRawValue: null,
      reason: `Insufficient recurring evidence in "${issue.column}" to impute safely without inventing data.`,
      repairMethod: 'Manual Review (No Fabrication)',
      operationType: 'manual_review',
      confidenceLevel: 'Low',
      manualReviewOnly: true,
    };
  }

  // 2. DUPLICATE RECORDS
  if (issue.issueType === 'Duplicate Records') {
    const isExact = issue.column === 'All Columns';
    const refRow = extractDuplicateReferenceRow(issue.description);
    return {
      id: baseId,
      datasetId,
      datasetName,
      issueId: issue.id,
      issueType: 'Duplicate Records',
      column: issue.column,
      rowNumber: issue.rowNumber,
      originalValue: issue.originalValue,
      proposedValue: refRow
        ? `Remove duplicate row (retain Row ${refRow})`
        : 'Remove duplicate row',
      proposedRawValue: null,
      reason: issue.description,
      repairMethod: isExact ? 'Remove Exact Duplicate Row' : 'Remove Duplicate Key Row',
      operationType: 'remove_duplicate_row',
      confidenceLevel: isExact ? 'High' : 'Medium',
      manualReviewOnly: false,
      duplicateOfRowNumber: refRow,
    };
  }

  // 3. INVALID FORMATS
  if (issue.issueType === 'Invalid Formats') {
    // Valid regional dates -> ISO-8601
    if (/non-iso date/i.test(issue.description)) {
      const normalized = normalizeValidRegionalDate(issue.originalValue);
      if (normalized) {
        return {
          id: baseId,
          datasetId,
          datasetName,
          issueId: issue.id,
          issueType: 'Invalid Formats',
          column: issue.column,
          rowNumber: issue.rowNumber,
          originalValue: issue.originalValue,
          proposedValue: normalized,
          proposedRawValue: normalized,
          reason: `Valid regional date "${issue.originalValue}" converted to ISO-8601 standard (YYYY-MM-DD).`,
          repairMethod: 'Normalize Date Format',
          operationType: 'normalize_date_format',
          confidenceLevel: 'High',
          manualReviewOnly: false,
        };
      }
    }

    // Currency-formatted numeric string -> clean decimal
    if (/currency-(?:formatted|prefixed)/i.test(issue.description)) {
      const parsed = parseCurrencyToNumber(issue.originalValue);
      if (parsed !== null) {
        return {
          id: baseId,
          datasetId,
          datasetName,
          issueId: issue.id,
          issueType: 'Invalid Formats',
          column: issue.column,
          rowNumber: issue.rowNumber,
          originalValue: issue.originalValue,
          proposedValue: String(parsed),
          proposedRawValue: parsed,
          reason: `Strip currency symbol/prefix from "${issue.originalValue}" and parse as clean numeric value.`,
          repairMethod: 'Normalize Numeric Format',
          operationType: 'coerce_numeric_format',
          confidenceLevel: 'High',
          manualReviewOnly: false,
        };
      }
    }

    // Trimming unnecessary spaces if only whitespace drift
    if (issue.originalValue !== issue.originalValue.trim()) {
      const trimmed = issue.originalValue.trim();
      return {
        id: baseId,
        datasetId,
        datasetName,
        issueId: issue.id,
        issueType: 'Invalid Formats',
        column: issue.column,
        rowNumber: issue.rowNumber,
        originalValue: issue.originalValue,
        proposedValue: trimmed,
        proposedRawValue: trimmed,
        reason: `Remove unnecessary leading/trailing whitespace in column "${issue.column}".`,
        repairMethod: 'Trim Unnecessary Spaces',
        operationType: 'trim_whitespace',
        confidenceLevel: 'High',
        manualReviewOnly: false,
      };
    }

    // Invalid emails, phone numbers, or impossible dates -> NEVER invent contact/date data
    return {
      id: baseId,
      datasetId,
      datasetName,
      issueId: issue.id,
      issueType: 'Invalid Formats',
      column: issue.column,
      rowNumber: issue.rowNumber,
      originalValue: issue.originalValue,
      proposedValue: 'Manual Review Required',
      proposedRawValue: null,
      reason: `${issue.description} Cannot safely auto-correct without verifying the source value.`,
      repairMethod: 'Manual Review (Verify Format)',
      operationType: 'manual_review',
      confidenceLevel: 'Low',
      manualReviewOnly: true,
    };
  }

  // 4. INCONSISTENT VALUES
  if (issue.issueType === 'Inconsistent Values') {
    const isWhitespace = /whitespace/i.test(issue.description);
    const target =
      extractCanonicalTargetFromAction(issue.suggestedAction) ??
      issue.originalValue.trim();

    if (isWhitespace) {
      return {
        id: baseId,
        datasetId,
        datasetName,
        issueId: issue.id,
        issueType: 'Inconsistent Values',
        column: issue.column,
        rowNumber: issue.rowNumber,
        originalValue: issue.originalValue,
        proposedValue: target,
        proposedRawValue: target,
        reason: `Unnecessary leading or trailing spaces detected in "${issue.column}".`,
        repairMethod: 'Trim Unnecessary Spaces',
        operationType: 'trim_whitespace',
        confidenceLevel: 'High',
        manualReviewOnly: false,
      };
    }

    const isFuzzy = /spelling variation/i.test(issue.description);
    return {
      id: baseId,
      datasetId,
      datasetName,
      issueId: issue.id,
      issueType: 'Inconsistent Values',
      column: issue.column,
      rowNumber: issue.rowNumber,
      originalValue: issue.originalValue,
      proposedValue: target,
      proposedRawValue: target,
      reason: issue.description,
      repairMethod: 'Standardize Category',
      operationType: 'standardize_category',
      confidenceLevel: isFuzzy ? 'Medium' : 'High',
      manualReviewOnly: false,
    };
  }

  // 5. ANOMALIES — ALWAYS highlight unusual values for manual review
  return {
    id: baseId,
    datasetId,
    datasetName,
    issueId: issue.id,
    issueType: 'Anomalies',
    column: issue.column,
    rowNumber: issue.rowNumber,
    originalValue: issue.originalValue,
    proposedValue: 'Flagged for Manual Review',
    proposedRawValue: null,
    reason: `${issue.description} Highlighted for analyst verification rather than automatic alteration.`,
    repairMethod: 'Manual Review (Anomaly Highlight)',
    operationType: 'manual_review',
    confidenceLevel: 'Low',
    manualReviewOnly: true,
  };
}

/**
 * Generates deterministic, row-level repair suggestions from Detection Engine findings.
 * Never mutates input rows or analysis results.
 */
export function generateRepairSuggestions(
  datasetId: string,
  datasetName: string,
  analysis: DatasetAnalysisResult,
  rows: readonly DataRow[]
): RepairSuggestion[] {
  return analysis.detailedIssues.map((issue, idx) =>
    buildSuggestionForIssue(
      datasetId,
      datasetName,
      {
        ...issue,
        id: `det-${datasetId}-${idx + 1}`,
        datasetId,
        datasetName,
      },
      rows,
      idx
    )
  );
}

export interface ApplyApprovedRepairsResult {
  updatedRows: DataRow[];
  appliedCount: number;
  cellsModified: number;
  rowsRemoved: number;
  skippedManualReviewCount: number;
  historyEntries: ModificationHistoryEntry[];
}

function formatTimestamp(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

/**
 * Applies ONLY explicitly approved, non-manual-review repair suggestions to a fresh copy
 * of `currentRows`. The caller's `currentRows` and original dataset rows are NEVER mutated.
 * Returns updated rows plus granular cell/row modification history entries.
 */
export function applyApprovedRepairSuggestions(params: {
  datasetId: string;
  datasetName: string;
  columns: readonly string[];
  currentRows: readonly DataRow[];
  suggestions: readonly RepairSuggestion[];
  approvals: readonly ApproveRepairSelection[];
  actor?: string;
}): ApplyApprovedRepairsResult {
  const {
    datasetId,
    datasetName,
    columns,
    currentRows,
    suggestions,
    approvals,
    actor = 'Workspace Analyst',
  } = params;

  // Always clone rows so original/current inputs remain immutable
  const workingRows: DataRow[] = currentRows.map((row) => ({ ...row }));
  const suggestionMap = new Map<string, RepairSuggestion>();
  for (const s of suggestions) {
    suggestionMap.set(s.id, s);
  }

  const timestamp = formatTimestamp();
  const historyEntries: ModificationHistoryEntry[] = [];
  const rowsToRemove = new Set<number>(); // 0-based row indices
  let cellsModified = 0;
  let appliedCount = 0;
  let skippedManualReviewCount = 0;

  // Deduplicate approval list by suggestionId
  const uniqueApprovals = new Map<string, ApproveRepairSelection>();
  for (const approval of approvals) {
    if (approval && typeof approval.suggestionId === 'string') {
      uniqueApprovals.set(approval.suggestionId, approval);
    }
  }

  // Phase 1: Apply all cell-level approved modifications (preserving exact 1-based row numbers first)
  for (const approval of uniqueApprovals.values()) {
    const suggestion = suggestionMap.get(approval.suggestionId);
    if (!suggestion) continue;

    if (suggestion.manualReviewOnly || suggestion.operationType === 'manual_review') {
      skippedManualReviewCount += 1;
      continue;
    }

    const rowIdx = suggestion.rowNumber - 1;
    if (rowIdx < 0 || rowIdx >= workingRows.length) continue;

    if (suggestion.operationType === 'remove_duplicate_row') {
      rowsToRemove.add(rowIdx);
      continue;
    }

    const row = workingRows[rowIdx];
    const col = suggestion.column;
    if (!columns.includes(col)) continue;

    let nextRawValue: string | number | null = suggestion.proposedRawValue;
    let appliedMethod = suggestion.repairMethod;
    let appliedConfidence: RepairConfidenceLevel = suggestion.confidenceLevel;

    // Allow user choice of Mean vs Median imputation for numerical missing values
    if (
      suggestion.operationType === 'impute_numeric_missing' &&
      suggestion.imputationOptions
    ) {
      const chosen =
        approval.imputationMethod ?? suggestion.imputationOptions.defaultMethod;
      if (chosen === 'mean') {
        nextRawValue = suggestion.imputationOptions.meanValue;
        appliedMethod = 'Mean Imputation';
      } else {
        nextRawValue = suggestion.imputationOptions.medianValue;
        appliedMethod = 'Median Imputation';
      }
    }

    // Safety guard: never write null/undefined as a fabricated replacement
    if (nextRawValue === null || nextRawValue === undefined) {
      continue;
    }

    const prevValue = row[col];
    const prevDisplay =
      prevValue === null || prevValue === undefined || prevValue === ''
        ? '(empty)'
        : String(prevValue);

    if (prevValue !== nextRawValue) {
      row[col] = nextRawValue;
      cellsModified += 1;
      appliedCount += 1;
      historyEntries.push({
        id: `mod-${Date.now().toString(36)}-${historyEntries.length + 1}`,
        datasetId,
        datasetName,
        timestamp,
        rowNumber: suggestion.rowNumber,
        column: col,
        issueType: suggestion.issueType,
        repairMethod: appliedMethod,
        originalValue: prevDisplay,
        newValue: String(nextRawValue),
        reason: suggestion.reason,
        confidenceLevel: appliedConfidence,
        action: 'Modified',
        actor,
      });
    }
  }

  // Phase 2: Remove approved duplicate rows (merging any non-null fields if duplicate key had richer data)
  let rowsRemoved = 0;
  for (const approval of uniqueApprovals.values()) {
    const suggestion = suggestionMap.get(approval.suggestionId);
    if (!suggestion || suggestion.operationType !== 'remove_duplicate_row') continue;
    const rowIdx = suggestion.rowNumber - 1;
    if (!rowsToRemove.has(rowIdx)) continue;

    // If duplicate key refers to an earlier row with missing fields, preserve non-null complementary values (never invent!)
    if (suggestion.duplicateOfRowNumber) {
      const refIdx = suggestion.duplicateOfRowNumber - 1;
      const refRow = workingRows[refIdx];
      const dupRow = workingRows[rowIdx];
      if (refRow && dupRow && !rowsToRemove.has(refIdx)) {
        for (const col of columns) {
          if (isMissingCell(refRow[col]) && !isMissingCell(dupRow[col])) {
            refRow[col] = dupRow[col];
            cellsModified += 1;
          }
        }
      }
    }

    rowsRemoved += 1;
    appliedCount += 1;
    cellsModified += 1;
    historyEntries.push({
      id: `mod-${Date.now().toString(36)}-${historyEntries.length + 1}`,
      datasetId,
      datasetName,
      timestamp,
      rowNumber: suggestion.rowNumber,
      column: suggestion.column,
      issueType: 'Duplicate Records',
      repairMethod: suggestion.repairMethod,
      originalValue: suggestion.originalValue,
      newValue: suggestion.proposedValue,
      reason: suggestion.reason,
      confidenceLevel: suggestion.confidenceLevel,
      action: 'Row Removed',
      actor,
    });
  }

  const finalRows =
    rowsToRemove.size > 0
      ? workingRows.filter((_, idx) => !rowsToRemove.has(idx))
      : workingRows;

  return {
    updatedRows: finalRows,
    appliedCount,
    cellsModified,
    rowsRemoved,
    skippedManualReviewCount,
    historyEntries,
  };
}
