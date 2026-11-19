import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDashboardMetrics,
  filterDatasets,
  filterIssues,
  formatQualityDelta,
  serializeRowsToCsv,
} from './qualityMetrics';
import type {
  AuditEntry,
  DatasetRecord,
  DiagnosisInsight,
  QualityIssue,
} from '../types/datafix';

const sampleDatasets: DatasetRecord[] = [
  {
    id: 'ds-1',
    name: 'customers_q4.csv',
    fileType: 'CSV',
    rows: 100,
    columns: 4,
    columnNames: ['id', 'name', 'email', 'country'],
    qualityScore: 88.5,
    previousScore: 76.0,
    openIssues: 2,
    repairedCells: 14,
    status: 'Needs Review',
    uploadedAt: '2026-11-18 09:00',
    previewRows: [],
    isDemo: true,
  },
  {
    id: 'ds-2',
    name: 'ledger_2026.xlsx',
    fileType: 'XLSX',
    rows: 240,
    columns: 6,
    columnNames: ['id', 'amount'],
    qualityScore: 98.0,
    previousScore: 98.0,
    openIssues: 0,
    repairedCells: 32,
    status: 'Validated',
    uploadedAt: '2026-11-17 12:00',
    previewRows: [],
    isDemo: true,
  },
];

const sampleIssues: QualityIssue[] = [
  {
    id: 'i-1',
    datasetId: 'ds-1',
    column: 'email',
    category: 'Missing Values',
    severity: 'Critical',
    affectedRows: 12,
    sampleValue: '(null)',
    ruleTriggered: 'Not null',
  },
  {
    id: 'i-2',
    datasetId: 'ds-1',
    column: 'country',
    category: 'Format Drift',
    severity: 'Warning',
    affectedRows: 8,
    sampleValue: 'uk',
    ruleTriggered: 'ISO-2',
  },
  {
    id: 'i-3',
    datasetId: 'ds-1',
    column: 'id',
    category: 'Duplicate Keys',
    severity: 'Critical',
    affectedRows: 3,
    sampleValue: 'C-10',
    ruleTriggered: 'Unique ID',
  },
];

test('filterDatasets filters by search query and dataset status', () => {
  assert.equal(filterDatasets(sampleDatasets, 'ledger', 'All').length, 1);
  assert.equal(filterDatasets(sampleDatasets, '', 'Validated').length, 1);
  assert.equal(filterDatasets(sampleDatasets, 'customers', 'Validated').length, 0);
});

test('filterIssues filters by dataset and severity', () => {
  assert.equal(filterIssues(sampleIssues, 'ALL', 'All').length, 3);
  assert.equal(filterIssues(sampleIssues, 'ds-1', 'Critical').length, 2);
  assert.equal(filterIssues(sampleIssues, 'ds-2', 'All').length, 0);
});

test('formatQualityDelta formats positive, negative, and zero deltas cleanly', () => {
  assert.equal(formatQualityDelta(92.4, 80.1), '+12.3%');
  assert.equal(formatQualityDelta(75.0, 80.0), '-5.0%');
  assert.equal(formatQualityDelta(90.0, 90.0), '0.0%');
});

test('serializeRowsToCsv outputs RFC-4180 CSV with headers', () => {
  const csv = serializeRowsToCsv([
    { id: '1', name: 'Northbridge' },
    { id: '2', name: 'Helios' },
  ]);
  assert.ok(csv.includes('id,name'));
  assert.ok(csv.includes('1,Northbridge'));
});

test('computeDashboardMetrics uses demonstration datasets until a real dataset is uploaded', () => {
  const audits: AuditEntry[] = [
    {
      id: 'a-1',
      timestamp: '2026-11-18 10:00',
      datasetName: 'customers_q4.csv',
      stage: 'Detect',
      action: 'Scanned demo dataset',
      actor: 'Rule Engine',
      outcome: 'Flagged',
    },
  ];
  const diagnoses: DiagnosisInsight[] = [];

  const demoMetrics = computeDashboardMetrics(
    sampleDatasets,
    sampleIssues,
    audits,
    diagnoses
  );
  assert.equal(demoMetrics.isDemoMode, true);
  assert.equal(demoMetrics.totalRecords, 340);
  assert.equal(demoMetrics.missingValues, 12);
  assert.equal(demoMetrics.duplicateRecords, 3);
  assert.equal(demoMetrics.invalidEntries, 8);
  assert.equal(demoMetrics.dataQualityScore, 93.3);

  // Add a real uploaded dataset
  const liveDataset: DatasetRecord = {
    id: 'ds-live',
    name: 'real_upload.csv',
    fileType: 'CSV',
    rows: 50,
    columns: 5,
    columnNames: ['id', 'email', 'cost'],
    qualityScore: 84.0,
    previousScore: 84.0,
    openIssues: 2,
    repairedCells: 0,
    status: 'Needs Review',
    uploadedAt: '2026-11-18 22:00',
    previewRows: [],
    isDemo: false,
  };
  const liveIssue: QualityIssue = {
    id: 'i-live',
    datasetId: 'ds-live',
    column: 'cost',
    category: 'Outlier Range',
    severity: 'Warning',
    affectedRows: 4,
    sampleValue: '-90',
    ruleTriggered: 'Non-negative',
  };

  const liveMetrics = computeDashboardMetrics(
    [liveDataset, ...sampleDatasets],
    [liveIssue, ...sampleIssues],
    audits,
    diagnoses
  );
  assert.equal(liveMetrics.isDemoMode, false);
  assert.equal(liveMetrics.totalRecords, 50);
  assert.equal(liveMetrics.missingValues, 0);
  assert.equal(liveMetrics.duplicateRecords, 0);
  assert.equal(liveMetrics.invalidEntries, 4);
  assert.equal(liveMetrics.dataQualityScore, 84.0);
});
