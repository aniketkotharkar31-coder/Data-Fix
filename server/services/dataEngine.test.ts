import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {
  aggregateIssueDistribution,
  applyRepairRulesToRows,
  buildExcelBuffer,
  computeDashboardMetrics,
  computeValidationChecks,
  generateRepairRules,
  parseCsvString,
  parseExcelBuffer,
  profileTabularData,
  serializeToCsv,
} from './dataEngine';
import type { DatasetRecord, QualityIssue } from '../../src/types/datafix';

test('parseCsvString parses CSV headers, numbers, and converts empty cells to null', () => {
  const sample = `customer_id,email,amount\nC-01,a@example.com,120.5\nC-02,,`;
  const parsed = parseCsvString(sample);
  assert.deepEqual(parsed.columns, ['customer_id', 'email', 'amount']);
  assert.equal(parsed.rowCount, 2);
  assert.equal(parsed.rows[0].amount, 120.5);
  assert.equal(parsed.rows[1].email, null);
});

test('parseExcelBuffer and buildExcelBuffer round-trip XLSX workbooks cleanly', () => {
  const rows = [
    { sku_id: 'SKU-1', price: 12.5 },
    { sku_id: 'SKU-2', price: 45.0 },
  ];
  const buf = buildExcelBuffer(rows, 'Inventory');
  const parsed = parseExcelBuffer(buf);
  assert.deepEqual(parsed.columns, ['sku_id', 'price']);
  assert.equal(parsed.rowCount, 2);
  assert.equal(parsed.rows[1].sku_id, 'SKU-2');
});

test('profileTabularData detects all five anomaly categories accurately', () => {
  const columns = [
    'customer_id',
    'contact_email',
    'country_code',
    'unit_cost',
    'renewal_date',
    'annual_value',
  ];
  const rows = [
    {
      customer_id: 'CUS-1',
      contact_email: null,
      country_code: 'uk',
      unit_cost: 'USD 42.50',
      renewal_date: '15/03/2027',
      annual_value: -500,
    },
    {
      customer_id: 'CUS-1',
      contact_email: 'ops@acme.io',
      country_code: 'GB',
      unit_cost: 42.5,
      renewal_date: '2027-03-15',
      annual_value: 500,
    },
  ];

  const profile = profileTabularData(columns, rows);
  const categories = new Set(profile.issues.map((i) => i.category));
  assert.ok(categories.has('Missing Values'));
  assert.ok(categories.has('Duplicate Keys'));
  assert.ok(categories.has('Schema Mismatch'));
  assert.ok(categories.has('Format Drift'));
  assert.ok(categories.has('Outlier Range'));
  assert.ok(profile.qualityScore < 100);
});

test('full autonomous repair loop eliminates anomalies and raises quality score to 100%', () => {
  const columns = [
    'customer_id',
    'company_name',
    'contact_email',
    'country_code',
    'unit_cost',
    'renewal_date',
    'annual_value_usd',
  ];
  const rows = [
    {
      customer_id: 'CUS-1',
      company_name: ' Acme Corp ',
      contact_email: null,
      country_code: 'uk',
      unit_cost: 'USD 42.50',
      renewal_date: '15/03/2027',
      annual_value_usd: -1200,
    },
    {
      customer_id: 'CUS-1',
      company_name: 'Acme Corp',
      contact_email: 'billing@acme.co.uk',
      country_code: 'GB',
      unit_cost: 42.5,
      renewal_date: '2027-03-15',
      annual_value_usd: 1200,
    },
    {
      customer_id: 'CUS-2',
      company_name: 'Beta Ltd',
      contact_email: null,
      country_code: 'US',
      unit_cost: 80,
      renewal_date: '2027-04-01',
      annual_value_usd: 5400,
    },
  ];

  const beforeProfile = profileTabularData(columns, rows);
  const issues: QualityIssue[] = beforeProfile.issues.map((i, idx) => ({
    ...i,
    id: `iss-${idx}`,
    datasetId: 'ds-test',
  }));

  const rules = generateRepairRules('ds-test', columns, rows, issues);
  assert.ok(rules.length >= 5);

  const { rows: repairedRows, cellsModified } = applyRepairRulesToRows(
    columns,
    rows,
    rules
  );
  assert.ok(cellsModified > 0);
  assert.equal(repairedRows.length, 2); // Duplicate merged
  assert.equal(repairedRows[0].company_name, 'Acme Corp');
  assert.equal(repairedRows[0].contact_email, 'billing@acme.co.uk');
  assert.equal(repairedRows[0].country_code, 'GB');
  assert.equal(repairedRows[0].unit_cost, 42.5);
  assert.equal(repairedRows[0].renewal_date, '2027-03-15');
  assert.equal(repairedRows[0].annual_value_usd, 1200);

  const afterProfile = profileTabularData(columns, repairedRows);
  assert.equal(afterProfile.openIssues, 0);
  assert.equal(afterProfile.qualityScore, 100);

  const checks = computeValidationChecks(
    'ds-test',
    beforeProfile.dimensions,
    afterProfile.dimensions,
    repairedRows.length
  );
  assert.equal(checks.length, 4);
  assert.ok(checks.every((c) => c.passed));

  const csvOut = serializeToCsv(repairedRows, columns);
  assert.ok(csvOut.includes('2027-03-15'));
});

test('aggregateIssueDistribution sums affected rows across all five issue categories', () => {
  const distribution = aggregateIssueDistribution([
    { category: 'Missing Values', affectedRows: 10 },
    { category: 'Missing Values', affectedRows: 5 },
    { category: 'Duplicate Keys', affectedRows: 3 },
  ]);

  assert.equal(distribution.length, 5);
  assert.equal(
    distribution.find((d) => d.category === 'Missing Values')?.count,
    15
  );
  assert.equal(
    distribution.find((d) => d.category === 'Duplicate Keys')?.count,
    3
  );
  assert.equal(
    distribution.find((d) => d.category === 'Outlier Range')?.count,
    0
  );
});

test('computeDashboardMetrics uses demo data initially and switches to real uploaded datasets once uploaded', () => {
  const demoDs: DatasetRecord = {
    id: 'demo-1',
    name: 'demo.csv',
    fileType: 'CSV',
    rows: 100,
    columns: 4,
    columnNames: ['id', 'email', 'cost', 'date'],
    qualityScore: 80,
    previousScore: 80,
    openIssues: 3,
    repairedCells: 0,
    status: 'Needs Review',
    uploadedAt: '2026-11-18 09:00',
    previewRows: [],
    isDemo: true,
  };

  const realDs: DatasetRecord = {
    ...demoDs,
    id: 'real-1',
    name: 'uploaded_live.csv',
    rows: 25,
    qualityScore: 96,
    previousScore: 96,
    openIssues: 1,
    isDemo: false,
  };

  const issues: QualityIssue[] = [
    {
      id: 'i-1',
      datasetId: 'demo-1',
      column: 'email',
      category: 'Missing Values',
      severity: 'Critical',
      affectedRows: 10,
      sampleValue: '(null)',
      ruleTriggered: 'Not null',
    },
    {
      id: 'i-2',
      datasetId: 'demo-1',
      column: 'id',
      category: 'Duplicate Keys',
      severity: 'Critical',
      affectedRows: 4,
      sampleValue: 'ID-1',
      ruleTriggered: 'Unique',
    },
    {
      id: 'i-3',
      datasetId: 'demo-1',
      column: 'cost',
      category: 'Schema Mismatch',
      severity: 'Warning',
      affectedRows: 6,
      sampleValue: '$10',
      ruleTriggered: 'Numeric',
    },
    {
      id: 'i-4',
      datasetId: 'real-1',
      column: 'email',
      category: 'Missing Values',
      severity: 'Warning',
      affectedRows: 2,
      sampleValue: '(null)',
      ruleTriggered: 'Not null',
    },
  ];

  const demoSummary = computeDashboardMetrics([demoDs], issues, []);
  assert.equal(demoSummary.isDemoMode, true);
  assert.equal(demoSummary.totalRecords, 100);
  assert.equal(demoSummary.missingValues, 10);
  assert.equal(demoSummary.duplicateRecords, 4);
  assert.equal(demoSummary.invalidEntries, 6);
  assert.equal(demoSummary.averageQualityScore, 80);

  const liveSummary = computeDashboardMetrics([realDs, demoDs], issues, []);
  assert.equal(liveSummary.isDemoMode, false);
  assert.equal(liveSummary.totalRecords, 25);
  assert.equal(liveSummary.missingValues, 2);
  assert.equal(liveSummary.duplicateRecords, 0);
  assert.equal(liveSummary.invalidEntries, 0);
  assert.equal(liveSummary.averageQualityScore, 96);
});
