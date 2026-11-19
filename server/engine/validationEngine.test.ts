import assert from 'node:assert/strict';
import test from 'node:test';
import type { DataRow, ModificationHistoryEntry } from '../../src/types/datafix.ts';
import { analyzeDataset } from './datasetAnalyzer.ts';
import {
  applyApprovedRepairSuggestions,
  generateRepairSuggestions,
} from './repairEngine.ts';
import { validateDatasetRepairs } from './validationEngine.ts';

function buildMultiIssueDataset(): { columns: string[]; rows: DataRow[] } {
  const columns = [
    'emp_id',
    'email',
    'department',
    'city',
    'hire_date',
    'score',
    'salary',
  ];
  const rows: DataRow[] = [
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
  return { columns, rows };
}

test('validateDatasetRepairs() reports accurate baseline counts before any repairs are approved', () => {
  const { columns, rows } = buildMultiIssueDataset();

  const { report, originalAnalysis } = validateDatasetRepairs({
    datasetId: 'ds-val-1',
    datasetName: 'hr_baseline.csv',
    fileType: 'CSV',
    columns,
    originalRows: rows,
    currentRows: rows,
    repairBatches: [],
  });

  // Baseline: remaining === original, zero repairs confirmed or failed
  assert.equal(report.reanalyzedAfterRepairs, false);
  assert.equal(report.validationStatus, 'Pending Repair');
  assert.equal(report.originalRowCount, 6);
  assert.equal(report.currentRowCount, 6);

  assert.equal(report.originalMissingValues, 3);
  assert.equal(report.remainingMissingValues, 3);

  assert.equal(report.originalDuplicateRecords, 1);
  assert.equal(report.remainingDuplicateRecords, 1);

  assert.equal(report.originalInvalidEntries, 6);
  assert.equal(report.remainingInvalidEntries, 6);

  assert.equal(report.totalIssuesDetected, originalAnalysis.detailedIssues.length);
  assert.equal(report.remainingIssues, originalAnalysis.detailedIssues.length);
  assert.equal(report.issuesSuccessfullyRepaired, 0);
  assert.equal(report.failedRepairs, 0);
  assert.equal(report.originalQualityScore, report.updatedQualityScore);
  assert.equal(report.qualityScoreImprovement, 0);
});

test('validateDatasetRepairs() re-analyzes after approved repairs and confirms all 8 metrics and quality score lift', () => {
  const { columns, rows } = buildMultiIssueDataset();
  const originalSnapshot = JSON.stringify(rows);

  const originalAnalysis = analyzeDataset({
    filename: 'hr_repaired.csv',
    fileType: 'CSV',
    columns,
    rows,
  });

  const suggestions = generateRepairSuggestions(
    'ds-val-2',
    'hr_repaired.csv',
    originalAnalysis,
    rows
  );

  // Approve all actionable repairs (missing score/dept, duplicate row 4, regional date, Bangalore->Bengaluru, trim Bengaluru)
  const actionable = suggestions.filter((s) => !s.manualReviewOnly);
  const repairResult = applyApprovedRepairSuggestions({
    datasetId: 'ds-val-2',
    datasetName: 'hr_repaired.csv',
    columns,
    currentRows: rows,
    suggestions,
    approvals: actionable.map((s) => ({
      suggestionId: s.id,
      imputationMethod: s.imputationOptions ? 'median' : undefined,
    })),
  });

  const { report } = validateDatasetRepairs({
    datasetId: 'ds-val-2',
    datasetName: 'hr_repaired.csv',
    fileType: 'CSV',
    columns,
    originalRows: rows,
    currentRows: repairResult.updatedRows,
    originalAnalysis,
    repairBatches: [repairResult.historyEntries],
  });

  // Original rows untouched
  assert.equal(JSON.stringify(rows), originalSnapshot);

  // Re-analysis confirmed all 6 actionable repairs
  assert.equal(report.reanalyzedAfterRepairs, true);
  assert.equal(report.originalRowCount, 6);
  assert.equal(report.currentRowCount, 5);

  // Missing values: 3 original (email, department, score) -> 1 remaining (email PII manual review)
  assert.equal(report.originalMissingValues, 3);
  assert.equal(report.remainingMissingValues, 1);

  // Duplicates: 1 original -> 0 remaining
  assert.equal(report.originalDuplicateRecords, 1);
  assert.equal(report.remainingDuplicateRecords, 0);

  // Invalid entries: 6 original -> 3 remaining (invalid email, impossible date 2025-02-30, salary anomaly 950000)
  assert.equal(report.originalInvalidEntries, 6);
  assert.equal(report.remainingInvalidEntries, 3);

  // Summary metrics
  assert.equal(report.totalIssuesDetected, 10);
  assert.equal(report.issuesSuccessfullyRepaired, 6);
  assert.equal(report.remainingIssues, 4);
  assert.equal(report.failedRepairs, 0);

  // Quality score improved positively
  assert.ok(report.updatedQualityScore > report.originalQualityScore);
  assert.equal(
    report.qualityScoreImprovement,
    Number((report.updatedQualityScore - report.originalQualityScore).toFixed(1))
  );
  assert.ok(report.qualityScoreImprovement > 0);
  assert.equal(report.validationStatus, 'Partially Validated');

  // Every repair outcome is explicitly Confirmed
  assert.equal(report.repairOutcomes.length, 6);
  assert.ok(report.repairOutcomes.every((o) => o.status === 'Confirmed'));
});

test('validateDatasetRepairs() detects failed repairs and NEVER reports unconfirmed repairs as successful', () => {
  const { columns, rows } = buildMultiIssueDataset();
  const originalAnalysis = analyzeDataset({
    filename: 'hr_failed_repair.csv',
    fileType: 'CSV',
    columns,
    rows,
  });

  // Simulate a flawed repair run where:
  // 1) hire_date on Row 2 was still written in non-ISO format "16/03/2025" (fails re-analysis!)
  // 2) score on Row 3 remained null despite a repair entry claiming it was imputed (fails re-analysis!)
  // 3) duplicate Row 4 was NOT actually removed from currentRows (fails re-analysis!)
  // 4) city on Row 2 WAS genuinely fixed to "Bengaluru" (confirmed!)
  const flawedRows: DataRow[] = rows.map((r) => ({ ...r }));
  flawedRows[1].hire_date = '16/03/2025'; // still invalid non-ISO date
  flawedRows[1].city = 'Bengaluru'; // genuinely fixed
  // flawedRows[2].score left null
  // flawedRows still has 6 rows (duplicate row 4 not removed)

  const attempted: ModificationHistoryEntry[] = [
    {
      id: 'mod-fail-1',
      datasetId: 'ds-val-3',
      datasetName: 'hr_failed_repair.csv',
      timestamp: '2026-11-19 10:00',
      rowNumber: 2,
      column: 'hire_date',
      issueType: 'Invalid Formats',
      repairMethod: 'Normalize Date Format',
      originalValue: '15/03/2025',
      newValue: '16/03/2025',
      reason: 'Attempted date normalization',
      confidenceLevel: 'High',
      action: 'Modified',
      actor: 'Test Runner',
    },
    {
      id: 'mod-fail-2',
      datasetId: 'ds-val-3',
      datasetName: 'hr_failed_repair.csv',
      timestamp: '2026-11-19 10:00',
      rowNumber: 3,
      column: 'score',
      issueType: 'Missing Values',
      repairMethod: 'Median Imputation',
      originalValue: '(empty)',
      newValue: '90',
      reason: 'Attempted numeric imputation',
      confidenceLevel: 'Medium',
      action: 'Modified',
      actor: 'Test Runner',
    },
    {
      id: 'mod-ok-3',
      datasetId: 'ds-val-3',
      datasetName: 'hr_failed_repair.csv',
      timestamp: '2026-11-19 10:00',
      rowNumber: 2,
      column: 'city',
      issueType: 'Inconsistent Values',
      repairMethod: 'Standardize Category',
      originalValue: 'Bangalore',
      newValue: 'Bengaluru',
      reason: 'Standardized city synonym',
      confidenceLevel: 'High',
      action: 'Modified',
      actor: 'Test Runner',
    },
    {
      id: 'mod-fail-4',
      datasetId: 'ds-val-3',
      datasetName: 'hr_failed_repair.csv',
      timestamp: '2026-11-19 10:00',
      rowNumber: 4,
      column: 'All Columns',
      issueType: 'Duplicate Records',
      repairMethod: 'Remove Duplicate Record',
      originalValue: 'E001',
      newValue: 'Remove duplicate row (retain Row 1)',
      reason: 'Attempted duplicate removal',
      confidenceLevel: 'High',
      action: 'Row Removed',
      actor: 'Test Runner',
    },
  ];

  const { report } = validateDatasetRepairs({
    datasetId: 'ds-val-3',
    datasetName: 'hr_failed_repair.csv',
    fileType: 'CSV',
    columns,
    originalRows: rows,
    currentRows: flawedRows,
    originalAnalysis,
    repairBatches: [attempted],
  });

  // Only the 1 genuinely verified repair (city -> Bengaluru) is confirmed; 3 are marked Failed!
  assert.equal(report.issuesSuccessfullyRepaired, 1);
  assert.equal(report.failedRepairs, 3);
  assert.equal(report.validationStatus, 'Validation Warning');

  const cityOutcome = report.repairOutcomes.find((o) => o.column === 'city');
  const dateOutcome = report.repairOutcomes.find((o) => o.column === 'hire_date');
  const scoreOutcome = report.repairOutcomes.find((o) => o.column === 'score');
  const dupOutcome = report.repairOutcomes.find(
    (o) => o.issueType === 'Duplicate Records'
  );

  assert.equal(cityOutcome?.status, 'Confirmed');
  assert.equal(dateOutcome?.status, 'Failed');
  assert.equal(scoreOutcome?.status, 'Failed');
  assert.equal(dupOutcome?.status, 'Failed');
});

test('validateDatasetRepairs() tracks shifted row indices across duplicate removal + subsequent repair batch', () => {
  const columns = ['id', 'city', 'start_date'];
  const originalRows: DataRow[] = [
    { id: 'A1', city: 'Bengaluru', start_date: '2025-01-01' },
    { id: 'A1', city: 'Bengaluru', start_date: '2025-01-01' }, // Row 2: exact duplicate
    { id: 'A2', city: 'Bangalore', start_date: '14/02/2025' }, // Row 3: shifts to Row 2 after Row 2 is removed
  ];

  const originalAnalysis = analyzeDataset({
    filename: 'shift_test.csv',
    fileType: 'CSV',
    columns,
    rows: originalRows,
  });

  // Batch 1: Remove duplicate Row 2 AND standardize Row 3 city ("Bangalore" -> "Bengaluru")
  const suggestions1 = generateRepairSuggestions(
    'ds-shift',
    'shift_test.csv',
    originalAnalysis,
    originalRows
  );
  const dupSugg = suggestions1.find((s) => s.issueType === 'Duplicate Records')!;
  const citySugg = suggestions1.find((s) => s.column === 'city')!;
  const batch1 = applyApprovedRepairSuggestions({
    datasetId: 'ds-shift',
    datasetName: 'shift_test.csv',
    columns,
    currentRows: originalRows,
    suggestions: suggestions1,
    approvals: [{ suggestionId: dupSugg.id }, { suggestionId: citySugg.id }],
  });

  // Batch 2: Now fix start_date on the shifted Row 2 ("14/02/2025" -> "2025-02-14")
  const midAnalysis = analyzeDataset({
    filename: 'shift_test.csv',
    fileType: 'CSV',
    columns,
    rows: batch1.updatedRows,
  });
  const suggestions2 = generateRepairSuggestions(
    'ds-shift',
    'shift_test.csv',
    midAnalysis,
    batch1.updatedRows
  );
  const dateSugg = suggestions2.find((s) => s.column === 'start_date')!;
  assert.equal(dateSugg.rowNumber, 2);

  const batch2 = applyApprovedRepairSuggestions({
    datasetId: 'ds-shift',
    datasetName: 'shift_test.csv',
    columns,
    currentRows: batch1.updatedRows,
    suggestions: suggestions2,
    approvals: [{ suggestionId: dateSugg.id }],
  });

  const { report } = validateDatasetRepairs({
    datasetId: 'ds-shift',
    datasetName: 'shift_test.csv',
    fileType: 'CSV',
    columns,
    originalRows,
    currentRows: batch2.updatedRows,
    originalAnalysis,
    repairBatches: [batch1.historyEntries, batch2.historyEntries],
  });

  assert.equal(report.totalIssuesDetected, 3);
  assert.equal(report.issuesSuccessfullyRepaired, 3);
  assert.equal(report.remainingIssues, 0);
  assert.equal(report.failedRepairs, 0);
  assert.equal(report.updatedQualityScore, 100);
  assert.equal(report.validationStatus, 'Validated');

  // Verify Row 3's city modification tracked its shifted position to Row 2
  const cityOutcome = report.repairOutcomes.find((o) => o.column === 'city');
  assert.equal(cityOutcome?.rowNumber, 3);
  assert.equal(cityOutcome?.adjustedRowNumber, 2);
  assert.equal(cityOutcome?.status, 'Confirmed');
});
