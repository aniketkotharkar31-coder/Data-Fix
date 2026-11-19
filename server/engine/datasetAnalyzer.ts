import type {
  DetectedIssueRecord,
  IssueSeverity,
  QualityIssue,
} from '../../src/types/datafix.ts';
import { detectAnomalies } from './anomalyDetector.ts';
import { detectDuplicates } from './duplicateDetector.ts';
import { detectInconsistentValues } from './inconsistentValueDetector.ts';
import { detectInvalidFormats } from './invalidFormatDetector.ts';
import { detectMissingValues } from './missingValueDetector.ts';
import { calculateQualityScore } from './qualityScoreCalculator.ts';
import type {
  DatasetAnalysisResult,
  ReadDatasetResult,
  TabularRow,
} from './types.ts';

export type AnalyzeDatasetInput =
  | ReadDatasetResult
  | {
      filename?: string;
      fileType?: 'CSV' | 'XLSX';
      fileSizeBytes?: number;
      columns: readonly string[];
      rows: ReadonlyArray<Readonly<TabularRow>>;
      truncated?: boolean;
    };

const SEVERITY_RANK: Record<IssueSeverity, number> = {
  Critical: 0,
  Warning: 1,
  Info: 2,
};

function formatInvalidFormatDetails(
  formatType: string,
  column: string,
  originalValue: string,
  suggestedValue?: string
): { description: string; suggestedAction: string } {
  switch (formatType) {
    case 'invalid_email':
      return {
        description: `Invalid email address "${originalValue}" in column "${column}".`,
        suggestedAction: 'Correct to a valid email address format (name@domain.tld).',
      };
    case 'invalid_phone':
      return {
        description: `Invalid telephone format "${originalValue}" in column "${column}".`,
        suggestedAction: 'Standardize to a valid phone number containing 7–15 digits (e.g., +1-555-0100).',
      };
    case 'non_iso_date':
      return {
        description: `Non-ISO date format "${originalValue}" detected in column "${column}".`,
        suggestedAction: suggestedValue
          ? `Standardize date to ISO-8601 format (${suggestedValue}).`
          : 'Standardize date value to ISO-8601 format (YYYY-MM-DD).',
      };
    case 'invalid_date':
      return {
        description: `Unparseable or impossible calendar date "${originalValue}" in column "${column}".`,
        suggestedAction: 'Verify source record and replace with a valid YYYY-MM-DD calendar date.',
      };
    case 'currency_string':
      return {
        description: `Currency-formatted text "${originalValue}" found in numeric column "${column}".`,
        suggestedAction: suggestedValue
          ? `Strip currency symbol and store numeric value ${suggestedValue}.`
          : 'Strip currency prefix/symbols and convert to numeric decimal.',
      };
    default:
      return {
        description: `Non-numeric value "${originalValue}" found in numeric column "${column}".`,
        suggestedAction: 'Replace with a valid numeric value or verify source entry.',
      };
  }
}

/**
 * Orchestrates all six reusable detection and scoring modules to analyze a dataset
 * and return structured JSON quality diagnostics (both column summaries and exact
 * row-level detected issues) without mutating the original dataset.
 */
export function analyzeDataset(input: AnalyzeDatasetInput): DatasetAnalysisResult {
  const columns = [...input.columns];
  const rows = input.rows;
  const filename = input.filename ?? 'dataset.csv';
  const fileType = input.fileType ?? 'CSV';

  const missingValues = detectMissingValues(columns, rows);
  const duplicates = detectDuplicates(columns, rows);
  const invalidFormats = detectInvalidFormats(columns, rows);
  const inconsistentValues = detectInconsistentValues(columns, rows);
  const anomalies = detectAnomalies(columns, rows);

  const qualityScore = calculateQualityScore({
    totalRows: rows.length,
    totalColumns: columns.length,
    missingValues,
    duplicates,
    invalidFormats,
    inconsistentValues,
    anomalies,
  });

  // 1. Column-level grouped QualityIssue list (for Dashboard charts, Repair Planner, AI Diagnosis)
  const issues: Omit<QualityIssue, 'id' | 'datasetId'>[] = [];
  // 2. Row-level DetectedIssueRecord list (exact 1-based row numbers & all 7 detection fields)
  const detailedIssues: Omit<DetectedIssueRecord, 'id' | 'datasetId'>[] = [];

  // Missing Values
  for (const colReport of missingValues.byColumn) {
    issues.push({
      column: colReport.column,
      category: 'Missing Values',
      severity: colReport.severity,
      affectedRows: colReport.missingCount,
      sampleValue: colReport.sampleValue,
      ruleTriggered: colReport.ruleTriggered,
    });

    for (const cell of colReport.cells) {
      detailedIssues.push({
        datasetName: filename,
        issueType: 'Missing Values',
        column: colReport.column,
        rowNumber: cell.rowIndex + 1,
        originalValue: cell.originalValue,
        description:
          cell.originalValue === '(empty)'
            ? `Missing or empty cell in required column "${colReport.column}".`
            : `Placeholder missing token "${cell.originalValue}" found in column "${colReport.column}".`,
        severity: colReport.severity,
        suggestedAction: `Impute missing value in "${colReport.column}" or populate from source system.`,
      });
    }
  }

  // Duplicate Records (exact full-row duplicates + conflicting key duplicates)
  const exactDupRowSet = new Set<number>();
  for (const match of duplicates.exactDuplicateMatches) {
    exactDupRowSet.add(match.rowIndex);
    detailedIssues.push({
      datasetName: filename,
      issueType: 'Duplicate Records',
      column: 'All Columns',
      rowNumber: match.rowIndex + 1,
      originalValue: match.originalValue,
      description: `Row ${match.rowIndex + 1} is a completely duplicated record matching Row ${match.firstRowIndex + 1}.`,
      severity: 'Critical',
      suggestedAction: `Remove duplicate record and retain Row ${match.firstRowIndex + 1}.`,
    });
  }

  if (duplicates.keyColumn && duplicates.keyDuplicateCount > 0) {
    issues.push({
      column: duplicates.keyColumn,
      category: 'Duplicate Keys',
      severity: 'Critical',
      affectedRows: duplicates.keyDuplicateCount,
      sampleValue: duplicates.duplicateKeys[0]?.keyValue ?? 'Duplicate key',
      ruleTriggered: 'Primary key uniqueness check',
    });

    for (const group of duplicates.duplicateKeys) {
      const firstRowNum = group.rowIndices[0] + 1;
      for (let idx = 1; idx < group.rowIndices.length; idx += 1) {
        const dupRowIdx = group.rowIndices[idx];
        if (exactDupRowSet.has(dupRowIdx)) continue;
        detailedIssues.push({
          datasetName: filename,
          issueType: 'Duplicate Records',
          column: group.column,
          rowNumber: dupRowIdx + 1,
          originalValue: group.keyValue,
          description: `Duplicate identifier "${group.keyValue}" in column "${group.column}" conflicts with Row ${firstRowNum}.`,
          severity: 'Critical',
          suggestedAction: `Merge non-null attributes with Row ${firstRowNum} and deduplicate "${group.keyValue}".`,
        });
      }
    }
  } else if (duplicates.exactDuplicateCount > 0) {
    issues.push({
      column: columns[0] ?? 'row',
      category: 'Duplicate Keys',
      severity: 'Critical',
      affectedRows: duplicates.exactDuplicateCount,
      sampleValue: `Row #${(duplicates.exactDuplicateRowIndices[0] ?? 0) + 1}`,
      ruleTriggered: 'Exact duplicate row check',
    });
  }

  // Invalid Formats
  for (const formatFinding of invalidFormats.findings) {
    issues.push({
      column: formatFinding.column,
      category: formatFinding.category,
      severity: formatFinding.severity,
      affectedRows: formatFinding.affectedRows,
      sampleValue: formatFinding.sampleValue,
      ruleTriggered: formatFinding.ruleTriggered,
    });

    for (const cell of formatFinding.cells) {
      const copy = formatInvalidFormatDetails(
        formatFinding.formatType,
        formatFinding.column,
        cell.originalValue,
        cell.suggestedValue
      );
      detailedIssues.push({
        datasetName: filename,
        issueType: 'Invalid Formats',
        column: formatFinding.column,
        rowNumber: cell.rowIndex + 1,
        originalValue: cell.originalValue,
        description: copy.description,
        severity: formatFinding.severity,
        suggestedAction: copy.suggestedAction,
      });
    }
  }

  // Inconsistent Values
  for (const inconsistent of inconsistentValues.findings) {
    issues.push({
      column: inconsistent.column,
      category: 'Format Drift',
      severity: inconsistent.severity,
      affectedRows: inconsistent.affectedRows,
      sampleValue: inconsistent.sampleValue,
      ruleTriggered: inconsistent.ruleTriggered,
    });

    for (const cell of inconsistent.cells) {
      let description = cell.detail ?? '';
      let suggestedAction = cell.suggestedValue
        ? `Standardize value to "${cell.suggestedValue}".`
        : `Standardize formatting in column "${inconsistent.column}".`;

      if (!description) {
        if (inconsistent.issueType === 'whitespace_drift') {
          description = `Leading or trailing whitespace detected in "${cell.originalValue}".`;
          suggestedAction = `Trim whitespace to "${cell.suggestedValue ?? cell.originalValue.trim()}".`;
        } else if (inconsistent.issueType === 'code_standardization') {
          description = `Non-standard code "${cell.originalValue}" in column "${inconsistent.column}".`;
          suggestedAction = `Standardize code to "${cell.suggestedValue ?? cell.originalValue.trim().toUpperCase()}".`;
        } else {
          description = `Inconsistent categorical value "${cell.originalValue}" in column "${inconsistent.column}".`;
        }
      }

      detailedIssues.push({
        datasetName: filename,
        issueType: 'Inconsistent Values',
        column: inconsistent.column,
        rowNumber: cell.rowIndex + 1,
        originalValue: cell.originalValue,
        description,
        severity: inconsistent.severity,
        suggestedAction,
      });
    }
  }

  // Anomalies (IQR & Numerical Bounds)
  for (const anomaly of anomalies.findings) {
    issues.push({
      column: anomaly.column,
      category: 'Outlier Range',
      severity: anomaly.severity,
      affectedRows: anomaly.affectedRows,
      sampleValue: anomaly.sampleValue,
      ruleTriggered: anomaly.ruleTriggered,
    });

    for (const cell of anomaly.cells) {
      let suggestedAction = 'Verify numerical anomaly against source data.';
      if (anomaly.anomalyType === 'negative_boundary') {
        suggestedAction = cell.suggestedValue
          ? `Review sign error and correct to positive value (${cell.suggestedValue}).`
          : 'Review negative sign-entry error and restore non-negative magnitude.';
      } else if (anomaly.anomalyType === 'statistical_outlier' && anomaly.bounds) {
        suggestedAction = `Verify extreme value against expected IQR range [${anomaly.bounds.min}, ${anomaly.bounds.max}] or cap/correct outlier.`;
      } else if (anomaly.anomalyType === 'domain_range') {
        suggestedAction = 'Verify impossible domain value and correct from source record.';
      }

      detailedIssues.push({
        datasetName: filename,
        issueType: 'Anomalies',
        column: anomaly.column,
        rowNumber: cell.rowIndex + 1,
        originalValue: cell.originalValue,
        description:
          cell.detail ??
          `Unusual numerical value "${cell.originalValue}" flagged in column "${anomaly.column}".`,
        severity: anomaly.severity,
        suggestedAction,
      });
    }
  }

  // Sort row-level issues deterministically by accurate row number ascending, then severity, then column
  detailedIssues.sort((a, b) => {
    if (a.rowNumber !== b.rowNumber) return a.rowNumber - b.rowNumber;
    const sevDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sevDiff !== 0) return sevDiff;
    return a.column.localeCompare(b.column);
  });

  return {
    datasetMeta: {
      filename,
      fileType,
      fileSizeBytes: input.fileSizeBytes,
      totalRows: rows.length,
      totalColumns: columns.length,
      columns,
      truncated: input.truncated ?? false,
    },
    summary: {
      totalRecords: rows.length,
      missingValues: missingValues.totalMissingCells,
      duplicateRecords: duplicates.totalDuplicateRows,
      invalidFormats: invalidFormats.totalInvalidCells,
      inconsistentValues: inconsistentValues.totalInconsistentCells,
      anomalies: anomalies.totalAnomalies,
      openIssues: issues.length,
      detailedIssueCount: detailedIssues.length,
      qualityScore: qualityScore.overallScore,
      grade: qualityScore.grade,
    },
    missingValues,
    duplicates,
    invalidFormats,
    inconsistentValues,
    anomalies,
    qualityScore,
    dimensions: qualityScore.dimensions,
    issues,
    detailedIssues,
  };
}
