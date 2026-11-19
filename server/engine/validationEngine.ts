import type {
  DataRow,
  DetectionIssueType,
  ModificationHistoryEntry,
  ValidationCategoryComparison,
  ValidationComparisonReport,
  ValidationRepairOutcome,
  ValidationReportStatus,
} from '../../src/types/datafix.ts';
import { computeValidationChecks } from '../services/dataEngine.ts';
import { analyzeDataset } from './datasetAnalyzer.ts';
import { isCellMissing } from './missingValueDetector.ts';
import type { DatasetAnalysisResult } from './types.ts';

export interface ValidateDatasetRepairsInput {
  datasetId: string;
  datasetName: string;
  fileType: 'CSV' | 'XLSX';
  fileSizeBytes?: number;
  columns: readonly string[];
  /** Preserved original dataset rows (never mutated) */
  originalRows: ReadonlyArray<Readonly<DataRow>>;
  /** Working dataset rows after approved repairs (re-analyzed fresh) */
  currentRows: ReadonlyArray<Readonly<DataRow>>;
  /** Optional cached baseline analysis of originalRows */
  originalAnalysis?: DatasetAnalysisResult;
  /**
   * Chronological batches of attempted repair modifications since the last restore.
   * Each batch contains `Modified` entries followed by `Row Removed` entries applied in that step.
   */
  repairBatches?: ReadonlyArray<ReadonlyArray<ModificationHistoryEntry>>;
  /** Optional flat list of attempted repair entries (treated as a single batch if repairBatches is omitted) */
  attemptedRepairs?: ReadonlyArray<ModificationHistoryEntry>;
  validatedAt?: string;
}

export interface ValidateDatasetRepairsOutput {
  report: ValidationComparisonReport;
  originalAnalysis: DatasetAnalysisResult;
  updatedAnalysis: DatasetAnalysisResult;
}

interface IssueCategoryCounts {
  missingValues: number;
  duplicateRecords: number;
  invalidFormats: number;
  inconsistentValues: number;
  anomalies: number;
  invalidEntries: number;
  totalIssues: number;
}

const CATEGORY_ORDER: DetectionIssueType[] = [
  'Missing Values',
  'Duplicate Records',
  'Invalid Formats',
  'Inconsistent Values',
  'Anomalies',
];

function formatTimestamp(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

function roundOneDecimal(value: number): number {
  return Number(value.toFixed(1));
}

function countIssuesByCategory(analysis: DatasetAnalysisResult): IssueCategoryCounts {
  let missingValues = 0;
  let duplicateRecords = 0;
  let invalidFormats = 0;
  let inconsistentValues = 0;
  let anomalies = 0;

  for (const issue of analysis.detailedIssues) {
    switch (issue.issueType) {
      case 'Missing Values':
        missingValues += 1;
        break;
      case 'Duplicate Records':
        duplicateRecords += 1;
        break;
      case 'Invalid Formats':
        invalidFormats += 1;
        break;
      case 'Inconsistent Values':
        inconsistentValues += 1;
        break;
      case 'Anomalies':
        anomalies += 1;
        break;
    }
  }

  const invalidEntries = invalidFormats + inconsistentValues + anomalies;
  const totalIssues = analysis.detailedIssues.length;

  return {
    missingValues,
    duplicateRecords,
    invalidFormats,
    inconsistentValues,
    anomalies,
    invalidEntries,
    totalIssues,
  };
}

function getCategoryCount(
  counts: IssueCategoryCounts,
  category: DetectionIssueType
): number {
  switch (category) {
    case 'Missing Values':
      return counts.missingValues;
    case 'Duplicate Records':
      return counts.duplicateRecords;
    case 'Invalid Formats':
      return counts.invalidFormats;
    case 'Inconsistent Values':
      return counts.inconsistentValues;
    case 'Anomalies':
      return counts.anomalies;
  }
}

interface TrackedRepairAttempt {
  entry: ModificationHistoryEntry;
  /** Final 1-based row number in currentRows after accounting for any subsequent duplicate deletions */
  adjustedRowNumber: number | null;
  removedInLaterStep: boolean;
}

/**
 * Replays chronological repair batches to compute the exact final 1-based row position
 * in `currentRows` for every cell-modification entry, even when duplicate rows were removed
 * in the same batch or subsequent batches.
 */
function buildTrackedAttempts(
  batches: ReadonlyArray<ReadonlyArray<ModificationHistoryEntry>>
): TrackedRepairAttempt[] {
  const tracked: TrackedRepairAttempt[] = [];

  for (const batch of batches) {
    const batchMods: TrackedRepairAttempt[] = [];
    const batchRemovedRowNumbers: number[] = [];

    for (const entry of batch) {
      if (entry.action === 'Restored Original') continue;
      if (entry.action === 'Modified') {
        const item: TrackedRepairAttempt = {
          entry,
          adjustedRowNumber: entry.rowNumber,
          removedInLaterStep: false,
        };
        batchMods.push(item);
        tracked.push(item);
      } else if (entry.action === 'Row Removed') {
        batchRemovedRowNumbers.push(entry.rowNumber);
        tracked.push({
          entry,
          adjustedRowNumber: null,
          removedInLaterStep: false,
        });
      }
    }

    // Apply row index shifts caused by duplicate removals executed at the end of this batch
    // to ALL cell modifications tracked so far (both earlier batches and this batch).
    if (batchRemovedRowNumbers.length > 0) {
      const sortedRemovals = [...new Set(batchRemovedRowNumbers)].sort((a, b) => a - b);
      for (const item of tracked) {
        if (item.entry.action !== 'Modified' || item.adjustedRowNumber === null) continue;
        let pos = item.adjustedRowNumber;
        if (sortedRemovals.includes(pos)) {
          item.adjustedRowNumber = null;
          item.removedInLaterStep = true;
          continue;
        }
        let shift = 0;
        for (const removedRow of sortedRemovals) {
          if (removedRow < pos) {
            shift += 1;
          }
        }
        item.adjustedRowNumber = pos - shift;
      }
    }

    void batchMods;
  }

  return tracked;
}

/**
 * DataFix Validation Engine:
 * Re-analyzes the current dataset after approved repairs using actual dataset records,
 * compares before-and-after metrics against the preserved original baseline, and
 * independently confirms whether each attempted repair succeeded or failed.
 *
 * Repairs are ONLY reported as successful after fresh re-analysis confirms the target
 * issue no longer exists.
 */
export function validateDatasetRepairs(
  input: ValidateDatasetRepairsInput
): ValidateDatasetRepairsOutput {
  const {
    datasetId,
    datasetName,
    fileType,
    fileSizeBytes,
    columns,
    originalRows,
    currentRows,
  } = input;

  const originalAnalysis =
    input.originalAnalysis ??
    analyzeDataset({
      filename: datasetName,
      fileType,
      fileSizeBytes,
      columns,
      rows: originalRows,
    });

  // Always re-analyze the current dataset fresh from actual rows
  const updatedAnalysis = analyzeDataset({
    filename: datasetName,
    fileType,
    fileSizeBytes,
    columns,
    rows: currentRows,
  });

  const before = countIssuesByCategory(originalAnalysis);
  const after = countIssuesByCategory(updatedAnalysis);

  const normalizedBatches: ReadonlyArray<ReadonlyArray<ModificationHistoryEntry>> =
    input.repairBatches && input.repairBatches.length > 0
      ? input.repairBatches
      : input.attemptedRepairs && input.attemptedRepairs.length > 0
        ? [input.attemptedRepairs]
        : [];

  const trackedAttempts = buildTrackedAttempts(normalizedBatches);

  // Index remaining post-repair issues by (rowNumber, column) for O(1) lookup
  const remainingByCell = new Map<string, typeof updatedAnalysis.detailedIssues>();
  for (const issue of updatedAnalysis.detailedIssues) {
    const key = `${issue.rowNumber}::${issue.column}`;
    const list = remainingByCell.get(key) ?? [];
    list.push(issue);
    remainingByCell.set(key, list);
  }

  // Track how many duplicate removals are genuinely verified by both row reduction and duplicate reduction
  const actualRowDrop = Math.max(0, originalRows.length - currentRows.length);
  const actualDuplicateDrop = Math.max(
    0,
    before.duplicateRecords - after.duplicateRecords
  );
  let remainingConfirmableDuplicateRemovals = Math.min(
    actualRowDrop,
    actualDuplicateDrop
  );

  const repairOutcomes: ValidationRepairOutcome[] = [];
  let confirmedRepairs = 0;
  let failedRepairs = 0;

  for (let idx = 0; idx < trackedAttempts.length; idx += 1) {
    const item = trackedAttempts[idx];
    const { entry } = item;
    if (entry.issueType === 'Dataset Restore') continue;

    if (entry.action === 'Row Removed') {
      if (remainingConfirmableDuplicateRemovals > 0) {
        remainingConfirmableDuplicateRemovals -= 1;
        confirmedRepairs += 1;
        repairOutcomes.push({
          id: `val-out-${datasetId}-${idx + 1}`,
          historyEntryId: entry.id,
          rowNumber: entry.rowNumber,
          adjustedRowNumber: null,
          column: entry.column,
          issueType: 'Duplicate Records',
          repairMethod: entry.repairMethod,
          originalValue: entry.originalValue,
          repairedValue: entry.newValue,
          status: 'Confirmed',
          verificationNote:
            'Confirmed by post-repair re-analysis: duplicate record was removed and duplicate count decreased.',
        });
      } else {
        failedRepairs += 1;
        repairOutcomes.push({
          id: `val-out-${datasetId}-${idx + 1}`,
          historyEntryId: entry.id,
          rowNumber: entry.rowNumber,
          adjustedRowNumber: null,
          column: entry.column,
          issueType: 'Duplicate Records',
          repairMethod: entry.repairMethod,
          originalValue: entry.originalValue,
          repairedValue: entry.newValue,
          status: 'Failed',
          verificationNote:
            'Validation could not confirm duplicate removal: row count or duplicate count did not decrease after re-analysis.',
        });
      }
      continue;
    }

    // Action === 'Modified'
    if (item.removedInLaterStep) {
      // Cell's row was subsequently removed as an approved duplicate — confirm only if duplicate drop occurred
      if (actualRowDrop > 0) {
        confirmedRepairs += 1;
        repairOutcomes.push({
          id: `val-out-${datasetId}-${idx + 1}`,
          historyEntryId: entry.id,
          rowNumber: entry.rowNumber,
          adjustedRowNumber: null,
          column: entry.column,
          issueType: entry.issueType,
          repairMethod: entry.repairMethod,
          originalValue: entry.originalValue,
          repairedValue: entry.newValue,
          status: 'Confirmed',
          verificationNote:
            'Confirmed: target row was subsequently deduplicated and no issue remains in the current dataset.',
        });
      } else {
        failedRepairs += 1;
        repairOutcomes.push({
          id: `val-out-${datasetId}-${idx + 1}`,
          historyEntryId: entry.id,
          rowNumber: entry.rowNumber,
          adjustedRowNumber: null,
          column: entry.column,
          issueType: entry.issueType,
          repairMethod: entry.repairMethod,
          originalValue: entry.originalValue,
          repairedValue: entry.newValue,
          status: 'Failed',
          verificationNote:
            'Validation failed: target row could not be located in the post-repair dataset.',
        });
      }
      continue;
    }

    const pos = item.adjustedRowNumber;
    if (pos === null || pos < 1 || pos > currentRows.length) {
      failedRepairs += 1;
      repairOutcomes.push({
        id: `val-out-${datasetId}-${idx + 1}`,
        historyEntryId: entry.id,
        rowNumber: entry.rowNumber,
        adjustedRowNumber: pos,
        column: entry.column,
        issueType: entry.issueType,
        repairMethod: entry.repairMethod,
        originalValue: entry.originalValue,
        repairedValue: entry.newValue,
        status: 'Failed',
        verificationNote: `Validation failed: Row ${entry.rowNumber} is out of bounds in the re-analyzed dataset (${currentRows.length} rows).`,
      });
      continue;
    }

    const currentRow = currentRows[pos - 1];
    const actualCellValue = currentRow?.[entry.column];
    const cellIssuesAfter = remainingByCell.get(`${pos}::${entry.column}`) ?? [];

    // 1. Check if re-analysis still flags this cell with an error
    const blockingIssue =
      cellIssuesAfter.find((iss) => iss.issueType === entry.issueType) ??
      cellIssuesAfter[0];

    if (blockingIssue) {
      failedRepairs += 1;
      repairOutcomes.push({
        id: `val-out-${datasetId}-${idx + 1}`,
        historyEntryId: entry.id,
        rowNumber: entry.rowNumber,
        adjustedRowNumber: pos,
        column: entry.column,
        issueType: entry.issueType,
        repairMethod: entry.repairMethod,
        originalValue: entry.originalValue,
        repairedValue: entry.newValue,
        status: 'Failed',
        verificationNote: `Post-repair re-analysis still flags Row ${pos} "${entry.column}" (${blockingIssue.issueType}): ${blockingIssue.description}`,
      });
      continue;
    }

    // 2. Verify the actual cell content changed away from the faulty state
    if (entry.issueType === 'Missing Values' && isCellMissing(actualCellValue)) {
      failedRepairs += 1;
      repairOutcomes.push({
        id: `val-out-${datasetId}-${idx + 1}`,
        historyEntryId: entry.id,
        rowNumber: entry.rowNumber,
        adjustedRowNumber: pos,
        column: entry.column,
        issueType: entry.issueType,
        repairMethod: entry.repairMethod,
        originalValue: entry.originalValue,
        repairedValue: entry.newValue,
        status: 'Failed',
        verificationNote: `Cell in Row ${pos} "${entry.column}" is still empty after repair.`,
      });
      continue;
    }

    const actualStr =
      actualCellValue === null || actualCellValue === undefined
        ? '(empty)'
        : String(actualCellValue);

    if (
      entry.originalValue !== entry.newValue &&
      actualStr === entry.originalValue
    ) {
      failedRepairs += 1;
      repairOutcomes.push({
        id: `val-out-${datasetId}-${idx + 1}`,
        historyEntryId: entry.id,
        rowNumber: entry.rowNumber,
        adjustedRowNumber: pos,
        column: entry.column,
        issueType: entry.issueType,
        repairMethod: entry.repairMethod,
        originalValue: entry.originalValue,
        repairedValue: entry.newValue,
        status: 'Failed',
        verificationNote: `Cell value in Row ${pos} "${entry.column}" remained unchanged ("${actualStr}") in the re-analyzed dataset.`,
      });
      continue;
    }

    // Confirmed by fresh re-analysis!
    confirmedRepairs += 1;
    repairOutcomes.push({
      id: `val-out-${datasetId}-${idx + 1}`,
      historyEntryId: entry.id,
      rowNumber: entry.rowNumber,
      adjustedRowNumber: pos,
      column: entry.column,
      issueType: entry.issueType,
      repairMethod: entry.repairMethod,
      originalValue: entry.originalValue,
      repairedValue: actualStr,
      status: 'Confirmed',
      verificationNote: `Confirmed by post-repair re-analysis: Row ${pos} "${entry.column}" ("${actualStr}") passes all quality checks.`,
    });
  }

  const originalQualityScore = roundOneDecimal(
    originalAnalysis.qualityScore.overallScore
  );
  const updatedQualityScore = roundOneDecimal(
    updatedAnalysis.qualityScore.overallScore
  );
  const qualityScoreImprovement = roundOneDecimal(
    updatedQualityScore - originalQualityScore
  );

  const reanalyzedAfterRepairs = repairOutcomes.length > 0;

  let validationStatus: ValidationReportStatus;
  if (!reanalyzedAfterRepairs && after.totalIssues === 0) {
    validationStatus = 'Validated (Clean Baseline)';
  } else if (!reanalyzedAfterRepairs && after.totalIssues > 0) {
    validationStatus = 'Pending Repair';
  } else if (failedRepairs > 0) {
    validationStatus = 'Validation Warning';
  } else if (after.totalIssues === 0) {
    validationStatus = 'Validated';
  } else {
    validationStatus = 'Partially Validated';
  }

  const categoryBreakdown: ValidationCategoryComparison[] = CATEGORY_ORDER.map(
    (category) => {
      const originalCount = getCategoryCount(before, category);
      const remainingCount = getCategoryCount(after, category);
      return {
        category,
        originalCount,
        remainingCount,
        resolvedCount: Math.max(0, originalCount - remainingCount),
      };
    }
  );

  const checks = computeValidationChecks(
    datasetId,
    originalAnalysis.dimensions,
    updatedAnalysis.dimensions,
    currentRows.length
  );

  const report: ValidationComparisonReport = {
    datasetId,
    datasetName,
    validatedAt: input.validatedAt ?? formatTimestamp(),
    validationStatus,
    reanalyzedAfterRepairs,
    originalRowCount: originalRows.length,
    currentRowCount: currentRows.length,
    originalMissingValues: before.missingValues,
    remainingMissingValues: after.missingValues,
    originalDuplicateRecords: before.duplicateRecords,
    remainingDuplicateRecords: after.duplicateRecords,
    originalInvalidEntries: before.invalidEntries,
    remainingInvalidEntries: after.invalidEntries,
    originalQualityScore,
    updatedQualityScore,
    totalIssuesDetected: before.totalIssues,
    issuesSuccessfullyRepaired: confirmedRepairs,
    remainingIssues: after.totalIssues,
    failedRepairs,
    qualityScoreImprovement,
    categoryBreakdown,
    repairOutcomes,
    checks,
  };

  return {
    report,
    originalAnalysis,
    updatedAnalysis,
  };
}
