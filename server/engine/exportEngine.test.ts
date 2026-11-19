import assert from 'node:assert/strict';
import test from 'node:test';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import type { DataRow, DatasetRecord } from '../../src/types/datafix.ts';
import { recordApprovedModifications } from './auditEngine.ts';
import { analyzeDataset } from './datasetAnalyzer.ts';
import {
  UTF8_BOM,
  buildCleanedCsvExport,
  buildCleanedExcelExport,
  buildDataQualityReportCsv,
  buildDataQualityReportExcel,
  buildDataQualityReportPayload,
  buildModificationHistoryCsv,
  buildModificationHistoryExcel,
} from './exportEngine.ts';
import {
  applyApprovedRepairSuggestions,
  generateRepairSuggestions,
} from './repairEngine.ts';
import { validateDatasetRepairs } from './validationEngine.ts';

function runPartialRepairScenario() {
  const columns = [
    'emp_id',
    'email',
    'department',
    'city',
    'hire_date',
    'score',
    'salary',
  ];
  const originalRows: DataRow[] = [
    {
      emp_id: 'E001',
      email: 'asha@acme.com',
      department: 'Engineering',
      city: 'Bengaluru',
      hire_date: '2025-01-10',
      score: 80,
      salary: 80000,
    },
    {
      emp_id: 'E002',
      email: 'amitgmail.com',
      department: 'Engineering',
      city: 'Bangalore',
      hire_date: '15/03/2025',
      score: 90,
      salary: 82000,
    },
    {
      emp_id: 'E003',
      email: null,
      department: null,
      city: ' Bengaluru ',
      hire_date: '2025-02-30',
      score: null,
      salary: 84000,
    },
    {
      emp_id: 'E001',
      email: 'asha@acme.com',
      department: 'Engineering',
      city: 'Bengaluru',
      hire_date: '2025-01-10',
      score: 80,
      salary: 80000,
    },
    {
      emp_id: 'E005',
      email: 'vikram@acme.com',
      department: 'Sales',
      city: 'Bengaluru',
      hire_date: '2025-04-01',
      score: 100,
      salary: 83000,
    },
    {
      emp_id: 'E006',
      email: 'priya@acme.com',
      department: 'Engineering',
      city: 'Bengaluru',
      hire_date: '2025-05-01',
      score: 90,
      salary: 950000,
    },
  ];

  const originalAnalysis = analyzeDataset({
    filename: 'export_test.csv',
    fileType: 'CSV',
    columns,
    rows: originalRows,
  });

  const suggestions = generateRepairSuggestions(
    'ds-exp',
    'export_test.csv',
    originalAnalysis,
    originalRows
  );

  // Approve ONLY hire_date normalization, duplicate removal, and score median imputation.
  // Deliberately leave city ("Bangalore") and department (missing) UNAPPROVED!
  const dateFix = suggestions.find(
    (s) => s.column === 'hire_date' && !s.manualReviewOnly
  )!;
  const dupFix = suggestions.find((s) => s.issueType === 'Duplicate Records')!;
  const scoreFix = suggestions.find(
    (s) => s.column === 'score' && s.issueType === 'Missing Values'
  )!;

  const repairResult = applyApprovedRepairSuggestions({
    datasetId: 'ds-exp',
    datasetName: 'export_test.csv',
    columns,
    currentRows: originalRows,
    suggestions,
    approvals: [
      { suggestionId: dateFix.id },
      { suggestionId: dupFix.id },
      { suggestionId: scoreFix.id, imputationMethod: 'median' },
    ],
  });

  const { report: validationReport, updatedAnalysis } = validateDatasetRepairs({
    datasetId: 'ds-exp',
    datasetName: 'export_test.csv',
    fileType: 'CSV',
    columns,
    originalRows,
    currentRows: repairResult.updatedRows,
    originalAnalysis,
    repairBatches: [repairResult.historyEntries],
  });

  const auditModifications = recordApprovedModifications({
    historyEntries: repairResult.historyEntries,
    validationReport,
  });

  const dataset: DatasetRecord = {
    id: 'ds-exp',
    name: 'export_test.csv',
    fileType: 'CSV',
    rows: repairResult.updatedRows.length,
    columns: columns.length,
    columnNames: columns,
    qualityScore: updatedAnalysis.qualityScore.overallScore,
    previousScore: originalAnalysis.qualityScore.overallScore,
    openIssues: updatedAnalysis.issues.length,
    repairedCells: repairResult.cellsModified,
    status: 'In Repair',
    uploadedAt: '2026-11-19 02:30',
    previewRows: repairResult.updatedRows.slice(0, 10),
    originalPreviewRows: originalRows.slice(0, 10),
    isDemo: false,
  };

  return {
    columns,
    originalRows,
    cleanedRows: repairResult.updatedRows,
    dataset,
    originalAnalysis,
    updatedAnalysis,
    validationReport,
    auditModifications,
  };
}

test('buildCleanedCsvExport() and buildCleanedExcelExport() export ONLY approved modifications and open cleanly in Excel/PapaParse', () => {
  const { columns, cleanedRows } = runPartialRepairScenario();

  // 1. Cleaned CSV (UTF-8 BOM + CRLF)
  const csv = buildCleanedCsvExport(cleanedRows, columns);
  assert.ok(csv.startsWith(UTF8_BOM), 'CSV must begin with UTF-8 BOM for Excel');
  assert.ok(csv.includes('\r\n'), 'CSV must use CRLF line endings for Excel');

  const parsedCsv = Papa.parse<Record<string, string>>(csv.slice(1).trim(), {
    header: true,
  });
  assert.deepEqual(parsedCsv.meta.fields, columns);
  assert.equal(parsedCsv.data.length, 5); // Approved duplicate Row 4 removed
  assert.equal(parsedCsv.data[1].hire_date, '2025-03-15'); // Approved date fix applied
  assert.equal(parsedCsv.data[2].score, '90'); // Approved median imputation applied
  assert.equal(parsedCsv.data[1].city, 'Bangalore'); // Unapproved city stayed untouched!
  assert.equal(parsedCsv.data[2].department, ''); // Unapproved missing department stayed empty!
  assert.equal(parsedCsv.data[4].salary, '950000'); // Manual-review anomaly untouched!

  // 2. Cleaned Excel (.xlsx) round-trip via SheetJS
  const xlsxBuf = buildCleanedExcelExport(cleanedRows, columns, 'CleanedData');
  assert.ok(Buffer.isBuffer(xlsxBuf));
  assert.equal(xlsxBuf[0], 0x50); // ZIP 'P'
  assert.equal(xlsxBuf[1], 0x4b); // ZIP 'K'

  const wb = XLSX.read(xlsxBuf, { type: 'buffer' });
  assert.deepEqual(wb.SheetNames, ['CleanedData']);
  const sheetRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(
    wb.Sheets['CleanedData'],
    { defval: '' }
  );
  assert.equal(sheetRows.length, 5);
  assert.equal(sheetRows[1].hire_date, '2025-03-15');
  assert.equal(sheetRows[2].score, 90);
  assert.equal(sheetRows[1].city, 'Bangalore');
  assert.equal(sheetRows[2].department, '');
});

test('buildDataQualityReportPayload(), buildDataQualityReportExcel(), and buildDataQualityReportCsv() include all 6 required sections and open cleanly in Excel', () => {
  const {
    dataset,
    originalAnalysis,
    updatedAnalysis,
    validationReport,
    auditModifications,
  } = runPartialRepairScenario();

  const payload = buildDataQualityReportPayload({
    dataset,
    originalAnalysis,
    currentAnalysis: updatedAnalysis,
    validationReport,
    auditModifications,
    generatedAt: '2026-11-19T02:30:00.000Z',
  });

  // All 6 required sections verified
  assert.equal(payload.originalDatasetStatistics.originalRowCount, 6);
  assert.equal(payload.originalDatasetStatistics.currentRowCount, 5);
  assert.equal(payload.originalDatasetStatistics.originalTotalIssues, 10);
  assert.equal(payload.detectedIssues.length, 10);
  assert.equal(payload.appliedRepairs.length, 3);
  assert.equal(payload.remainingIssues.length, updatedAnalysis.detailedIssues.length);
  assert.equal(payload.validationResults.issuesSuccessfullyRepaired, 3);
  assert.equal(payload.validationResults.failedRepairs, 0);
  assert.equal(payload.validationResults.checks.length, 4);
  assert.equal(payload.finalQualityScore.finalScore, validationReport.updatedQualityScore);
  assert.ok(payload.finalQualityScore.improvement > 0);

  // Multi-sheet Excel workbook opens cleanly in SheetJS/Excel
  const reportXlsx = buildDataQualityReportExcel(payload);
  const wb = XLSX.read(reportXlsx, { type: 'buffer' });
  assert.deepEqual(wb.SheetNames, [
    'Summary',
    'Detected Issues',
    'Applied Repairs',
    'Remaining Issues',
    'Validation Results',
  ]);

  const summaryRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(
    wb.Sheets['Summary']
  );
  assert.ok(
    summaryRows.some(
      (r) =>
        r.Metric === 'Original Row Count' && r.Value === 6
    )
  );
  assert.ok(
    summaryRows.some(
      (r) =>
        r.Metric === 'Final Quality Score (%)' &&
        r.Value === payload.finalQualityScore.finalScore
    )
  );

  const appliedRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(
    wb.Sheets['Applied Repairs']
  );
  assert.equal(appliedRows.length, 3);
  assert.ok(appliedRows.every((r) => r['Validation Status'] === 'Confirmed'));

  // Sectioned CSV opens cleanly with UTF-8 BOM & CRLF
  const reportCsv = buildDataQualityReportCsv(payload);
  assert.ok(reportCsv.startsWith(UTF8_BOM));
  assert.ok(reportCsv.includes('1. ORIGINAL DATASET STATISTICS'));
  assert.ok(reportCsv.includes('2. FINAL QUALITY SCORE & VALIDATION RESULTS'));
  assert.ok(reportCsv.includes('4. DETECTED ISSUES (ORIGINAL BASELINE)'));
  assert.ok(reportCsv.includes('5. APPLIED REPAIRS (APPROVED MODIFICATIONS)'));
  assert.ok(reportCsv.includes('6. REMAINING ISSUES'));
});

test('buildModificationHistoryExcel() and buildModificationHistoryCsv() export Excel-readable modification histories with all 8 audit fields', () => {
  const { auditModifications } = runPartialRepairScenario();

  const histXlsx = buildModificationHistoryExcel(auditModifications);
  const wb = XLSX.read(histXlsx, { type: 'buffer' });
  assert.deepEqual(wb.SheetNames, ['Modification History']);
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(
    wb.Sheets['Modification History']
  );
  assert.equal(rows.length, 3);
  assert.ok('Row Number' in rows[0]);
  assert.ok('Column Name' in rows[0]);
  assert.ok('Original Value' in rows[0]);
  assert.ok('Updated Value' in rows[0]);
  assert.ok('Reason for Modification' in rows[0]);
  assert.ok('Repair Method' in rows[0]);
  assert.ok('Timestamp' in rows[0]);
  assert.ok('Validation Status' in rows[0]);

  const histCsv = buildModificationHistoryCsv(auditModifications);
  assert.ok(histCsv.startsWith(UTF8_BOM));
  assert.ok(histCsv.includes('\r\n'));
  assert.match(
    histCsv.slice(1),
    /^Row Number,Column Name,Original Value,Updated Value,Reason for Modification,Repair Method,Timestamp,Validation Status/
  );
});
