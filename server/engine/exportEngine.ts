import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import type {
  AuditModificationRecord,
  DataQualityReportExport,
  DataRow,
  DatasetRecord,
  ValidationComparisonReport,
} from '../../src/types/datafix.ts';
import type { DatasetAnalysisResult } from './types.ts';

/** UTF-8 Byte Order Mark so Microsoft Excel opens UTF-8 CSV files with accurate encoding */
export const UTF8_BOM = '\uFEFF';

function sanitizeSheetName(name: string): string {
  const cleaned = name.replace(/[\\/?*[\]:]/g, ' ').trim();
  return (cleaned.slice(0, 31) || 'Sheet1').trim();
}

function escapeCsvCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function computeAutoColumnWidths(
  headers: readonly string[],
  rows: ReadonlyArray<Record<string, unknown>>,
  maxWidth = 48
): XLSX.ColInfo[] {
  return headers.map((header) => {
    let longest = header.length;
    for (const row of rows) {
      const val = row[header];
      const text = val === null || val === undefined ? '' : String(val);
      if (text.length > longest) {
        longest = text.length;
      }
    }
    return { wch: Math.min(Math.max(longest + 2, 10), maxWidth) };
  });
}

function buildWorksheetFromObjects(
  headers: readonly string[],
  records: ReadonlyArray<Record<string, string | number | null | undefined>>
): XLSX.WorkSheet {
  const normalizedRows = records.map((rec) => {
    const out: Record<string, string | number> = {};
    for (const col of headers) {
      const val = rec[col];
      out[col] = val === null || val === undefined ? '' : val;
    }
    return out;
  });

  const sheet =
    normalizedRows.length > 0
      ? XLSX.utils.json_to_sheet(normalizedRows, { header: [...headers] })
      : XLSX.utils.aoa_to_sheet([[...headers]]);

  sheet['!cols'] = computeAutoColumnWidths(headers, normalizedRows);
  return sheet;
}

/**
 * Exports cleaned dataset rows (containing ONLY approved modifications) as an
 * Excel-compatible UTF-8 CSV with BOM and CRLF line endings.
 */
export function buildCleanedCsvExport(
  rows: ReadonlyArray<Readonly<DataRow>>,
  columns: readonly string[]
): string {
  const orderedCols =
    columns.length > 0
      ? [...columns]
      : rows.length > 0
        ? Object.keys(rows[0])
        : [];

  if (rows.length === 0) {
    return `${UTF8_BOM}${orderedCols.map(escapeCsvCell).join(',')}\r\n`;
  }

  const normalized = rows.map((row) => {
    const out: Record<string, string | number> = {};
    for (const col of orderedCols) {
      const val = row[col];
      out[col] = val === null || val === undefined ? '' : val;
    }
    return out;
  });

  const csvBody = Papa.unparse(normalized, {
    columns: orderedCols,
    newline: '\r\n',
  });

  return `${UTF8_BOM}${csvBody}\r\n`;
}

/**
 * Exports cleaned dataset rows (containing ONLY approved modifications) as a
 * valid Microsoft Excel (.xlsx) workbook with preserved column order and auto-sized columns.
 */
export function buildCleanedExcelExport(
  rows: ReadonlyArray<Readonly<DataRow>>,
  columns: readonly string[],
  sheetName = 'CleanedData'
): Buffer {
  const orderedCols =
    columns.length > 0
      ? [...columns]
      : rows.length > 0
        ? Object.keys(rows[0])
        : ['Data'];

  const worksheet = buildWorksheetFromObjects(orderedCols, rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    worksheet,
    sanitizeSheetName(sheetName)
  );
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/**
 * Assembles the complete Data Quality Report payload covering all 6 required sections:
 * 1. Original dataset statistics
 * 2. Detected issues (original baseline)
 * 3. Applied repairs (only approved modifications)
 * 4. Remaining issues (post-repair re-analysis)
 * 5. Validation results
 * 6. Final quality score
 */
export function buildDataQualityReportPayload(params: {
  dataset: DatasetRecord;
  originalAnalysis: DatasetAnalysisResult;
  currentAnalysis: DatasetAnalysisResult;
  validationReport: ValidationComparisonReport;
  auditModifications: readonly AuditModificationRecord[];
  generatedAt?: string;
}): DataQualityReportExport {
  const {
    dataset,
    originalAnalysis,
    currentAnalysis,
    validationReport,
    auditModifications,
    generatedAt = new Date().toISOString(),
  } = params;

  const activeDatasetMods = auditModifications.filter(
    (m) => m.datasetId === dataset.id && m.validationStatus !== 'Reverted'
  );

  return {
    reportTitle: `${dataset.name} — DataFix Data Quality Report`,
    generatedAt,
    datasetId: dataset.id,
    datasetName: dataset.name,
    fileType: dataset.fileType,
    onlyApprovedModificationsExported: true,
    originalDatasetStatistics: {
      originalRowCount: validationReport.originalRowCount,
      currentRowCount: validationReport.currentRowCount,
      totalColumns: dataset.columns,
      columnNames: [...dataset.columnNames],
      fileSizeBytes: dataset.fileSizeBytes,
      originalMissingValues: validationReport.originalMissingValues,
      originalDuplicateRecords: validationReport.originalDuplicateRecords,
      originalInvalidEntries: validationReport.originalInvalidEntries,
      originalTotalIssues: validationReport.totalIssuesDetected,
      originalQualityScore: validationReport.originalQualityScore,
      originalGrade: originalAnalysis.qualityScore.grade,
    },
    detectedIssues: originalAnalysis.detailedIssues.map((iss) => ({
      rowNumber: iss.rowNumber,
      column: iss.column,
      issueType: iss.issueType,
      originalValue: iss.originalValue,
      severity: iss.severity,
      description: iss.description,
      suggestedAction: iss.suggestedAction,
    })),
    appliedRepairs: activeDatasetMods.map((mod) => ({
      rowNumber: mod.rowNumber,
      columnName: mod.columnName,
      originalValue: mod.originalValue,
      updatedValue: mod.updatedValue,
      reason: mod.reason,
      repairMethod: mod.repairMethod,
      timestamp: mod.timestamp,
      validationStatus: mod.validationStatus,
      verificationNote: mod.verificationNote ?? '',
    })),
    remainingIssues: currentAnalysis.detailedIssues.map((iss) => ({
      rowNumber: iss.rowNumber,
      column: iss.column,
      issueType: iss.issueType,
      currentValue: iss.originalValue,
      severity: iss.severity,
      description: iss.description,
      suggestedAction: iss.suggestedAction,
    })),
    validationResults: {
      validationStatus: validationReport.validationStatus,
      validatedAt: validationReport.validatedAt,
      totalIssuesDetected: validationReport.totalIssuesDetected,
      issuesSuccessfullyRepaired: validationReport.issuesSuccessfullyRepaired,
      remainingIssues: validationReport.remainingIssues,
      failedRepairs: validationReport.failedRepairs,
      originalMissingValues: validationReport.originalMissingValues,
      remainingMissingValues: validationReport.remainingMissingValues,
      originalDuplicateRecords: validationReport.originalDuplicateRecords,
      remainingDuplicateRecords: validationReport.remainingDuplicateRecords,
      originalInvalidEntries: validationReport.originalInvalidEntries,
      remainingInvalidEntries: validationReport.remainingInvalidEntries,
      checks: validationReport.checks.map((c) => ({ ...c })),
    },
    finalQualityScore: {
      originalScore: validationReport.originalQualityScore,
      finalScore: validationReport.updatedQualityScore,
      improvement: validationReport.qualityScoreImprovement,
      grade: currentAnalysis.qualityScore.grade,
      dimensions: { ...currentAnalysis.dimensions },
    },
  };
}

/**
 * Generates a multi-sheet Microsoft Excel (.xlsx) Data Quality Report containing
 * dedicated, cleanly formatted tabs for Summary & Statistics, Detected Issues,
 * Applied Repairs, Remaining Issues, and Validation Results.
 */
export function buildDataQualityReportExcel(
  report: DataQualityReportExport
): Buffer {
  const workbook = XLSX.utils.book_new();

  // Sheet 1: Summary & Original Dataset Statistics + Final Quality Score
  const summaryRows: Array<Record<string, string | number>> = [
    { Section: 'Report Metadata', Metric: 'Report Title', Value: report.reportTitle },
    { Section: 'Report Metadata', Metric: 'Dataset Name', Value: report.datasetName },
    { Section: 'Report Metadata', Metric: 'Source File Type', Value: report.fileType },
    { Section: 'Report Metadata', Metric: 'Generated At', Value: report.generatedAt },
    {
      Section: 'Original Dataset Statistics',
      Metric: 'Original Row Count',
      Value: report.originalDatasetStatistics.originalRowCount,
    },
    {
      Section: 'Original Dataset Statistics',
      Metric: 'Current Cleaned Row Count',
      Value: report.originalDatasetStatistics.currentRowCount,
    },
    {
      Section: 'Original Dataset Statistics',
      Metric: 'Total Columns',
      Value: report.originalDatasetStatistics.totalColumns,
    },
    {
      Section: 'Original Dataset Statistics',
      Metric: 'Column Names',
      Value: report.originalDatasetStatistics.columnNames.join(', '),
    },
    {
      Section: 'Original Dataset Statistics',
      Metric: 'Original Missing Values',
      Value: report.originalDatasetStatistics.originalMissingValues,
    },
    {
      Section: 'Original Dataset Statistics',
      Metric: 'Original Duplicate Records',
      Value: report.originalDatasetStatistics.originalDuplicateRecords,
    },
    {
      Section: 'Original Dataset Statistics',
      Metric: 'Original Invalid Entries',
      Value: report.originalDatasetStatistics.originalInvalidEntries,
    },
    {
      Section: 'Original Dataset Statistics',
      Metric: 'Total Issues Detected',
      Value: report.originalDatasetStatistics.originalTotalIssues,
    },
    {
      Section: 'Original Dataset Statistics',
      Metric: 'Original Quality Score (%)',
      Value: report.originalDatasetStatistics.originalQualityScore,
    },
    {
      Section: 'Validation Results',
      Metric: 'Validation Status',
      Value: report.validationResults.validationStatus,
    },
    {
      Section: 'Validation Results',
      Metric: 'Issues Successfully Repaired (Confirmed)',
      Value: report.validationResults.issuesSuccessfullyRepaired,
    },
    {
      Section: 'Validation Results',
      Metric: 'Remaining Issues',
      Value: report.validationResults.remainingIssues,
    },
    {
      Section: 'Validation Results',
      Metric: 'Failed Repairs',
      Value: report.validationResults.failedRepairs,
    },
    {
      Section: 'Validation Results',
      Metric: 'Remaining Missing Values',
      Value: report.validationResults.remainingMissingValues,
    },
    {
      Section: 'Validation Results',
      Metric: 'Remaining Duplicate Records',
      Value: report.validationResults.remainingDuplicateRecords,
    },
    {
      Section: 'Validation Results',
      Metric: 'Remaining Invalid Entries',
      Value: report.validationResults.remainingInvalidEntries,
    },
    {
      Section: 'Final Quality Score',
      Metric: 'Final Quality Score (%)',
      Value: report.finalQualityScore.finalScore,
    },
    {
      Section: 'Final Quality Score',
      Metric: 'Quality Score Improvement (%)',
      Value: report.finalQualityScore.improvement,
    },
    {
      Section: 'Final Quality Score',
      Metric: 'Final Quality Grade',
      Value: report.finalQualityScore.grade,
    },
    {
      Section: 'Final Quality Score',
      Metric: 'Completeness Dimension (%)',
      Value: report.finalQualityScore.dimensions.completeness,
    },
    {
      Section: 'Final Quality Score',
      Metric: 'Validity Dimension (%)',
      Value: report.finalQualityScore.dimensions.validity,
    },
    {
      Section: 'Final Quality Score',
      Metric: 'Uniqueness Dimension (%)',
      Value: report.finalQualityScore.dimensions.uniqueness,
    },
    {
      Section: 'Final Quality Score',
      Metric: 'Consistency Dimension (%)',
      Value: report.finalQualityScore.dimensions.consistency,
    },
  ];
  XLSX.utils.book_append_sheet(
    workbook,
    buildWorksheetFromObjects(['Section', 'Metric', 'Value'], summaryRows),
    'Summary'
  );

  // Sheet 2: Detected Issues (Original)
  const detectedHeaders = [
    'Row Number',
    'Column',
    'Issue Type',
    'Original Value',
    'Severity',
    'Description',
    'Suggested Action',
  ];
  const detectedRows = report.detectedIssues.map((iss) => ({
    'Row Number': iss.rowNumber,
    Column: iss.column,
    'Issue Type': iss.issueType,
    'Original Value': iss.originalValue,
    Severity: iss.severity,
    Description: iss.description,
    'Suggested Action': iss.suggestedAction,
  }));
  XLSX.utils.book_append_sheet(
    workbook,
    buildWorksheetFromObjects(detectedHeaders, detectedRows),
    'Detected Issues'
  );

  // Sheet 3: Applied Repairs
  const repairHeaders = [
    'Row Number',
    'Column Name',
    'Original Value',
    'Updated Value',
    'Reason for Modification',
    'Repair Method',
    'Timestamp',
    'Validation Status',
    'Verification Note',
  ];
  const repairRows = report.appliedRepairs.map((rep) => ({
    'Row Number': rep.rowNumber,
    'Column Name': rep.columnName,
    'Original Value': rep.originalValue,
    'Updated Value': rep.updatedValue,
    'Reason for Modification': rep.reason,
    'Repair Method': rep.repairMethod,
    Timestamp: rep.timestamp,
    'Validation Status': rep.validationStatus,
    'Verification Note': rep.verificationNote,
  }));
  XLSX.utils.book_append_sheet(
    workbook,
    buildWorksheetFromObjects(repairHeaders, repairRows),
    'Applied Repairs'
  );

  // Sheet 4: Remaining Issues
  const remainingHeaders = [
    'Row Number',
    'Column',
    'Issue Type',
    'Current Value',
    'Severity',
    'Description',
    'Suggested Action',
  ];
  const remainingRows = report.remainingIssues.map((iss) => ({
    'Row Number': iss.rowNumber,
    Column: iss.column,
    'Issue Type': iss.issueType,
    'Current Value': iss.currentValue,
    Severity: iss.severity,
    Description: iss.description,
    'Suggested Action': iss.suggestedAction,
  }));
  XLSX.utils.book_append_sheet(
    workbook,
    buildWorksheetFromObjects(remainingHeaders, remainingRows),
    'Remaining Issues'
  );

  // Sheet 5: Validation Results
  const validationHeaders = [
    'Validation Check',
    'Dimension',
    'Before Score (%)',
    'After Score (%)',
    'Outcome',
    'Details',
  ];
  const validationRows = report.validationResults.checks.map((chk) => ({
    'Validation Check': chk.checkName,
    Dimension: chk.dimension,
    'Before Score (%)': chk.beforeScore,
    'After Score (%)': chk.afterScore,
    Outcome: chk.passed ? 'Passed' : 'Review Required',
    Details: chk.details,
  }));
  XLSX.utils.book_append_sheet(
    workbook,
    buildWorksheetFromObjects(validationHeaders, validationRows),
    'Validation Results'
  );

  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/**
 * Generates an Excel-compatible UTF-8 CSV Data Quality Report (with BOM + CRLF)
 * containing all 6 required sections cleanly organized for spreadsheet viewing.
 */
export function buildDataQualityReportCsv(
  report: DataQualityReportExport
): string {
  const lines: string[] = [];
  const pushRow = (cells: Array<string | number | null | undefined>) => {
    lines.push(cells.map(escapeCsvCell).join(','));
  };

  pushRow(['DATAFIX DATA QUALITY REPORT']);
  pushRow(['Dataset Name', report.datasetName]);
  pushRow(['Generated At', report.generatedAt]);
  pushRow([]);

  pushRow(['1. ORIGINAL DATASET STATISTICS']);
  pushRow(['Metric', 'Value']);
  pushRow(['Original Row Count', report.originalDatasetStatistics.originalRowCount]);
  pushRow(['Current Cleaned Row Count', report.originalDatasetStatistics.currentRowCount]);
  pushRow(['Total Columns', report.originalDatasetStatistics.totalColumns]);
  pushRow(['Original Missing Values', report.originalDatasetStatistics.originalMissingValues]);
  pushRow(['Original Duplicate Records', report.originalDatasetStatistics.originalDuplicateRecords]);
  pushRow(['Original Invalid Entries', report.originalDatasetStatistics.originalInvalidEntries]);
  pushRow(['Total Issues Detected', report.originalDatasetStatistics.originalTotalIssues]);
  pushRow(['Original Quality Score (%)', report.originalDatasetStatistics.originalQualityScore]);
  pushRow([]);

  pushRow(['2. FINAL QUALITY SCORE & VALIDATION RESULTS']);
  pushRow(['Metric', 'Value']);
  pushRow(['Final Quality Score (%)', report.finalQualityScore.finalScore]);
  pushRow(['Quality Score Improvement (%)', report.finalQualityScore.improvement]);
  pushRow(['Final Quality Grade', report.finalQualityScore.grade]);
  pushRow(['Validation Status', report.validationResults.validationStatus]);
  pushRow(['Issues Successfully Repaired (Confirmed)', report.validationResults.issuesSuccessfullyRepaired]);
  pushRow(['Remaining Issues', report.validationResults.remainingIssues]);
  pushRow(['Failed Repairs', report.validationResults.failedRepairs]);
  pushRow(['Remaining Missing Values', report.validationResults.remainingMissingValues]);
  pushRow(['Remaining Duplicate Records', report.validationResults.remainingDuplicateRecords]);
  pushRow(['Remaining Invalid Entries', report.validationResults.remainingInvalidEntries]);
  pushRow([]);

  pushRow(['3. VALIDATION GATE ASSERTIONS']);
  pushRow(['Check', 'Dimension', 'Before (%)', 'After (%)', 'Outcome', 'Details']);
  for (const chk of report.validationResults.checks) {
    pushRow([
      chk.checkName,
      chk.dimension,
      chk.beforeScore,
      chk.afterScore,
      chk.passed ? 'Passed' : 'Review Required',
      chk.details,
    ]);
  }
  pushRow([]);

  pushRow(['4. DETECTED ISSUES (ORIGINAL BASELINE)']);
  pushRow(['Row Number', 'Column', 'Issue Type', 'Original Value', 'Severity', 'Description', 'Suggested Action']);
  for (const iss of report.detectedIssues) {
    pushRow([
      iss.rowNumber,
      iss.column,
      iss.issueType,
      iss.originalValue,
      iss.severity,
      iss.description,
      iss.suggestedAction,
    ]);
  }
  pushRow([]);

  pushRow(['5. APPLIED REPAIRS (APPROVED MODIFICATIONS)']);
  pushRow(['Row Number', 'Column Name', 'Original Value', 'Updated Value', 'Reason for Modification', 'Repair Method', 'Timestamp', 'Validation Status']);
  for (const rep of report.appliedRepairs) {
    pushRow([
      rep.rowNumber,
      rep.columnName,
      rep.originalValue,
      rep.updatedValue,
      rep.reason,
      rep.repairMethod,
      rep.timestamp,
      rep.validationStatus,
    ]);
  }
  pushRow([]);

  pushRow(['6. REMAINING ISSUES']);
  pushRow(['Row Number', 'Column', 'Issue Type', 'Current Value', 'Severity', 'Description', 'Suggested Action']);
  for (const iss of report.remainingIssues) {
    pushRow([
      iss.rowNumber,
      iss.column,
      iss.issueType,
      iss.currentValue,
      iss.severity,
      iss.description,
      iss.suggestedAction,
    ]);
  }

  return `${UTF8_BOM}${lines.join('\r\n')}\r\n`;
}

/**
 * Generates an Excel-compatible UTF-8 CSV Modification History report (BOM + CRLF).
 */
export function buildModificationHistoryCsv(
  records: readonly AuditModificationRecord[]
): string {
  const headers = [
    'Row Number',
    'Column Name',
    'Original Value',
    'Updated Value',
    'Reason for Modification',
    'Repair Method',
    'Timestamp',
    'Validation Status',
    'Dataset Name',
    'Issue Type',
    'Actor',
    'Verification Note',
  ];

  const lines: string[] = [headers.map(escapeCsvCell).join(',')];
  for (const rec of records) {
    lines.push(
      [
        rec.rowNumber,
        rec.columnName,
        rec.originalValue,
        rec.updatedValue,
        rec.reason,
        rec.repairMethod,
        rec.timestamp,
        rec.validationStatus,
        rec.datasetName,
        rec.issueType,
        rec.actor,
        rec.verificationNote ?? '',
      ]
        .map(escapeCsvCell)
        .join(',')
    );
  }

  return `${UTF8_BOM}${lines.join('\r\n')}\r\n`;
}

/**
 * Generates a Microsoft Excel (.xlsx) workbook for Modification History
 * with all 8 required audit fields and auto-sized column widths.
 */
export function buildModificationHistoryExcel(
  records: readonly AuditModificationRecord[]
): Buffer {
  const headers = [
    'Row Number',
    'Column Name',
    'Original Value',
    'Updated Value',
    'Reason for Modification',
    'Repair Method',
    'Timestamp',
    'Validation Status',
    'Dataset Name',
    'Issue Type',
    'Actor',
    'Verification Note',
  ];

  const rows = records.map((rec) => ({
    'Row Number': rec.rowNumber,
    'Column Name': rec.columnName,
    'Original Value': rec.originalValue,
    'Updated Value': rec.updatedValue,
    'Reason for Modification': rec.reason,
    'Repair Method': rec.repairMethod,
    Timestamp: rec.timestamp,
    'Validation Status': rec.validationStatus,
    'Dataset Name': rec.datasetName,
    'Issue Type': rec.issueType,
    Actor: rec.actor,
    'Verification Note': rec.verificationNote ?? '',
  }));

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    buildWorksheetFromObjects(headers, rows),
    'Modification History'
  );
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
