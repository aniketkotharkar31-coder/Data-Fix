import assert from 'node:assert/strict';
import test from 'node:test';
import type { DataRow } from '../../src/types/datafix.ts';
import {
  buildAuditReportJson,
  filterAuditModifications,
  markDatasetAuditModificationsReverted,
  recordApprovedModifications,
  serializeAuditReportCsv,
  syncAuditValidationStatuses,
} from './auditEngine.ts';
import { analyzeDataset } from './datasetAnalyzer.ts';
import {
  applyApprovedRepairSuggestions,
  generateRepairSuggestions,
} from './repairEngine.ts';
import { validateDatasetRepairs } from './validationEngine.ts';

function buildSampleDataset(): { columns: string[]; rows: DataRow[] } {
  const columns = ['emp_id', 'department', 'city', 'hire_date', 'score'];
  const rows: DataRow[] = [
    {
      emp_id: 'E001',
      department: 'Engineering',
      city: 'Bengaluru',
      hire_date: '2025-01-10',
      score: 80,
    },
    {
      emp_id: 'E002',
      department: 'Engineering',
      city: 'Bangalore',
      hire_date: '15/03/2025',
      score: 90,
    },
    {
      emp_id: 'E003',
      department: null,
      city: ' Bengaluru ',
      hire_date: '2025-04-01',
      score: null,
    },
    {
      emp_id: 'E001',
      department: 'Engineering',
      city: 'Bengaluru',
      hire_date: '2025-01-10',
      score: 80,
    },
    {
      emp_id: 'E005',
      department: 'Sales',
      city: 'Bengaluru',
      hire_date: '2025-05-01',
      score: 100,
    },
  ];
  return { columns, rows };
}

test('recordApprovedModifications() captures all 8 audit fields directly from actual repair + validation operations', () => {
  const { columns, rows } = buildSampleDataset();
  const originalAnalysis = analyzeDataset({
    filename: 'audit_ops.csv',
    fileType: 'CSV',
    columns,
    rows,
  });

  const suggestions = generateRepairSuggestions(
    'ds-aud-1',
    'audit_ops.csv',
    originalAnalysis,
    rows
  );
  const actionable = suggestions.filter((s) => !s.manualReviewOnly);

  const repairResult = applyApprovedRepairSuggestions({
    datasetId: 'ds-aud-1',
    datasetName: 'audit_ops.csv',
    columns,
    currentRows: rows,
    suggestions,
    approvals: actionable.map((s) => ({
      suggestionId: s.id,
      imputationMethod: s.imputationOptions ? 'median' : undefined,
    })),
  });

  const { report: validationReport } = validateDatasetRepairs({
    datasetId: 'ds-aud-1',
    datasetName: 'audit_ops.csv',
    fileType: 'CSV',
    columns,
    originalRows: rows,
    currentRows: repairResult.updatedRows,
    originalAnalysis,
    repairBatches: [repairResult.historyEntries],
  });

  const auditRecords = recordApprovedModifications({
    historyEntries: repairResult.historyEntries,
    validationReport,
  });

  assert.equal(auditRecords.length, repairResult.historyEntries.length);
  assert.ok(auditRecords.length >= 5);

  for (const rec of auditRecords) {
    assert.ok(rec.rowNumber >= 1);
    assert.ok(rec.columnName.length > 0);
    assert.ok(rec.originalValue.length > 0);
    assert.ok(rec.updatedValue.length > 0);
    assert.ok(rec.reason.length > 0);
    assert.ok(rec.repairMethod.length > 0);
    assert.ok(rec.timestamp.length > 0);
    assert.equal(rec.validationStatus, 'Confirmed');
  }

  const cityRecord = auditRecords.find(
    (r) => r.columnName === 'city' && r.originalValue === 'Bangalore'
  );
  assert.ok(cityRecord);
  assert.equal(cityRecord.rowNumber, 2);
  assert.equal(cityRecord.updatedValue, 'Bengaluru');
  assert.equal(cityRecord.repairMethod, 'Standardize Category');

  const dupRecord = auditRecords.find((r) => r.action === 'Row Removed');
  assert.ok(dupRecord);
  assert.equal(dupRecord.rowNumber, 4);
  assert.equal(dupRecord.validationStatus, 'Confirmed');
});

test('filterAuditModifications() filters accurately by column, repair method, validation status, and search text', () => {
  const { columns, rows } = buildSampleDataset();
  const originalAnalysis = analyzeDataset({
    filename: 'audit_filter.csv',
    fileType: 'CSV',
    columns,
    rows,
  });
  const suggestions = generateRepairSuggestions(
    'ds-aud-2',
    'audit_filter.csv',
    originalAnalysis,
    rows
  );
  const repairResult = applyApprovedRepairSuggestions({
    datasetId: 'ds-aud-2',
    datasetName: 'audit_filter.csv',
    columns,
    currentRows: rows,
    suggestions,
    approvals: suggestions
      .filter((s) => !s.manualReviewOnly)
      .map((s) => ({
        suggestionId: s.id,
        imputationMethod: s.imputationOptions ? 'median' : undefined,
      })),
  });

  const { report } = validateDatasetRepairs({
    datasetId: 'ds-aud-2',
    datasetName: 'audit_filter.csv',
    fileType: 'CSV',
    columns,
    originalRows: rows,
    currentRows: repairResult.updatedRows,
    originalAnalysis,
    repairBatches: [repairResult.historyEntries],
  });

  const records = recordApprovedModifications({
    historyEntries: repairResult.historyEntries,
    validationReport: report,
  });

  const byColumn = filterAuditModifications(records, { columnName: 'hire_date' });
  assert.equal(byColumn.length, 1);
  assert.equal(byColumn[0].updatedValue, '2025-03-15');

  const byMethod = filterAuditModifications(records, {
    repairMethod: 'Mode Imputation',
  });
  assert.equal(byMethod.length, 1);
  assert.equal(byMethod[0].columnName, 'department');

  const bySearch = filterAuditModifications(records, { searchQuery: 'bangalore' });
  assert.equal(bySearch.length, 1);
  assert.equal(bySearch[0].columnName, 'city');

  const byFailed = filterAuditModifications(records, {
    validationStatus: 'Failed',
  });
  assert.equal(byFailed.length, 0);
});

test('syncAuditValidationStatuses() and markDatasetAuditModificationsReverted() preserve audit trail and update statuses cleanly', () => {
  const { columns, rows } = buildSampleDataset();
  const originalAnalysis = analyzeDataset({
    filename: 'audit_sync.csv',
    fileType: 'CSV',
    columns,
    rows,
  });
  const suggestions = generateRepairSuggestions(
    'ds-aud-3',
    'audit_sync.csv',
    originalAnalysis,
    rows
  );
  const dateSuggestion = suggestions.find((s) => s.column === 'hire_date')!;
  const repairResult = applyApprovedRepairSuggestions({
    datasetId: 'ds-aud-3',
    datasetName: 'audit_sync.csv',
    columns,
    currentRows: rows,
    suggestions,
    approvals: [{ suggestionId: dateSuggestion.id }],
  });

  // Record initially without validation report -> Pending Validation
  const initialRecords = recordApprovedModifications({
    historyEntries: repairResult.historyEntries,
  });
  assert.equal(initialRecords[0].validationStatus, 'Pending Validation');

  // Run validation and sync -> Confirmed
  const { report } = validateDatasetRepairs({
    datasetId: 'ds-aud-3',
    datasetName: 'audit_sync.csv',
    fileType: 'CSV',
    columns,
    originalRows: rows,
    currentRows: repairResult.updatedRows,
    originalAnalysis,
    repairBatches: [repairResult.historyEntries],
  });
  const synced = syncAuditValidationStatuses(initialRecords, report);
  assert.equal(synced[0].validationStatus, 'Confirmed');

  // Restore dataset -> Reverted (record preserved, never deleted)
  const reverted = markDatasetAuditModificationsReverted(synced, 'ds-aud-3');
  assert.equal(reverted.length, 1);
  assert.equal(reverted[0].validationStatus, 'Reverted');
});

test('serializeAuditReportCsv() and buildAuditReportJson() export all 8 required audit fields properly', () => {
  const { columns, rows } = buildSampleDataset();
  const originalAnalysis = analyzeDataset({
    filename: 'audit_export.csv',
    fileType: 'CSV',
    columns,
    rows,
  });
  const suggestions = generateRepairSuggestions(
    'ds-aud-4',
    'audit_export.csv',
    originalAnalysis,
    rows
  );
  const repairResult = applyApprovedRepairSuggestions({
    datasetId: 'ds-aud-4',
    datasetName: 'audit_export.csv',
    columns,
    currentRows: rows,
    suggestions,
    approvals: suggestions
      .filter((s) => !s.manualReviewOnly)
      .map((s) => ({
        suggestionId: s.id,
        imputationMethod: s.imputationOptions ? 'median' : undefined,
      })),
  });
  const { report } = validateDatasetRepairs({
    datasetId: 'ds-aud-4',
    datasetName: 'audit_export.csv',
    fileType: 'CSV',
    columns,
    originalRows: rows,
    currentRows: repairResult.updatedRows,
    originalAnalysis,
    repairBatches: [repairResult.historyEntries],
  });

  const records = recordApprovedModifications({
    historyEntries: repairResult.historyEntries,
    validationReport: report,
  });

  const csv = serializeAuditReportCsv(records);
  const lines = csv.split('\n');
  assert.equal(lines.length, records.length + 1);
  assert.match(
    lines[0],
    /^Row Number,Column Name,Original Value,Updated Value,Reason for Modification,Repair Method,Timestamp,Validation Status/
  );
  assert.match(csv, /Bangalore/);
  assert.match(csv, /Bengaluru/);
  assert.match(csv, /Confirmed/);

  const json = buildAuditReportJson(records, '2026-11-19T02:10:00.000Z');
  assert.equal(json.summary.totalModifications, records.length);
  assert.equal(json.summary.confirmedCount, records.length);
  assert.equal(json.summary.failedCount, 0);
  assert.equal(json.modifications.length, records.length);
  assert.ok('rowNumber' in json.modifications[0]);
  assert.ok('columnName' in json.modifications[0]);
  assert.ok('originalValue' in json.modifications[0]);
  assert.ok('updatedValue' in json.modifications[0]);
  assert.ok('reasonForModification' in json.modifications[0]);
  assert.ok('repairMethod' in json.modifications[0]);
  assert.ok('timestamp' in json.modifications[0]);
  assert.ok('validationStatus' in json.modifications[0]);
});
