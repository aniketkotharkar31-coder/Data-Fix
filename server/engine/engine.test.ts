import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {
  DatasetProcessingError,
  analyzeDataset,
  calculateQualityScore,
  detectAnomalies,
  detectDuplicates,
  detectInconsistentValues,
  detectInvalidFormats,
  detectMissingValues,
  readDataset,
  type TabularRow,
} from './index.ts';

test('readDataset() reads valid CSV via PapaParse and preserves frozen originalRows', () => {
  const csv = [
    'customer_id,company_name,contact_email,country_code,amount_usd,renewal_date',
    'C-1, Acme Corp ,ops@acme.io,uk,1200,15/03/2027',
    'C-2,Beta LLC,,US,-500,2027-04-01',
  ].join('\n');

  const buf = Buffer.from(csv, 'utf8');
  const result = readDataset({ buffer: buf, filename: 'customers.csv' });

  assert.equal(result.filename, 'customers.csv');
  assert.equal(result.fileType, 'CSV');
  assert.equal(result.fileSizeBytes, buf.byteLength);
  assert.equal(result.totalRows, 2);
  assert.equal(result.totalColumns, 6);
  assert.equal(result.truncated, false);
  assert.equal(result.originalRows[0].company_name, ' Acme Corp ');
  assert.equal(result.originalRows[1].contact_email, null);
  assert.equal(Object.isFrozen(result.originalRows), true);
  assert.equal(Object.isFrozen(result.originalRows[0]), true);
});

test('readDataset() reads valid Excel (.xlsx) via SheetJS and preserves original rows', () => {
  const rows: TabularRow[] = [
    { order_id: 'O-1', currency: 'usd ', unit_cost: 'USD 45.00', order_date: '2026-11-18' },
    { order_id: 'O-2', currency: 'EUR', unit_cost: 90.5, order_date: '19/11/2026' },
  ];
  const sheet = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, 'Orders');
  const xlsxBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

  const result = readDataset({ buffer: xlsxBuffer, filename: 'orders.xlsx' });
  assert.equal(result.fileType, 'XLSX');
  assert.equal(result.totalRows, 2);
  assert.equal(result.totalColumns, 4);
  assert.equal(result.originalRows[0].currency, 'usd ');
  assert.equal(result.originalRows[0].unit_cost, 'USD 45.00');
});

test('readDataset() rejects unsupported formats, empty files, corrupted files, and oversized files', () => {
  assert.throws(
    () => readDataset({ buffer: Buffer.from('hello'), filename: 'notes.txt' }),
    (err: unknown) =>
      err instanceof DatasetProcessingError && err.code === 'UNSUPPORTED_FORMAT'
  );

  assert.throws(
    () => readDataset({ buffer: Buffer.alloc(0), filename: 'empty.csv' }),
    (err: unknown) =>
      err instanceof DatasetProcessingError && err.code === 'EMPTY_FILE'
  );

  assert.throws(
    () => readDataset({ buffer: Buffer.from('NOT_A_ZIP'), filename: 'broken.xlsx' }),
    (err: unknown) =>
      err instanceof DatasetProcessingError && err.code === 'CORRUPTED_FILE'
  );

  assert.throws(
    () =>
      readDataset({
        buffer: Buffer.from('id,name\n1,a\n2,b'),
        filename: 'big.csv',
        maxBytes: 5,
      }),
    (err: unknown) =>
      err instanceof DatasetProcessingError && err.code === 'FILE_TOO_LARGE' && err.statusCode === 413
  );
});

test('readDataset() safely caps large files using maxRows without crashing', () => {
  const lines = ['id,amount'];
  for (let i = 1; i <= 50; i += 1) {
    lines.push(`ID-${i},${i * 10}`);
  }
  const result = readDataset({
    buffer: Buffer.from(lines.join('\n'), 'utf8'),
    filename: 'large.csv',
    maxRows: 20,
  });

  assert.equal(result.truncated, true);
  assert.equal(result.sourceRowCount, 50);
  assert.equal(result.totalRows, 20);
});

test('detectMissingValues() detects nulls, empty strings, and sentinel placeholders', () => {
  const columns = ['id', 'email', 'notes'];
  const rows: TabularRow[] = [
    { id: '1', email: null, notes: 'ok' },
    { id: '2', email: 'a@b.com', notes: 'N/A' },
    { id: '3', email: '  ', notes: 'valid' },
  ];
  const report = detectMissingValues(columns, rows);
  assert.equal(report.totalMissingCells, 3);
  assert.equal(report.affectedRowCount, 3);
  assert.equal(report.byColumn.length, 2);
});

test('detectDuplicates() identifies both primary key duplicates and exact full-row duplicates', () => {
  const columns = ['customer_id', 'name'];
  const rows: TabularRow[] = [
    { customer_id: 'C-1', name: 'Alpha' },
    { customer_id: 'C-1', name: 'Alpha' },
    { customer_id: 'C-2', name: 'Beta' },
    { customer_id: 'C-2', name: 'Beta Updated' },
  ];
  const report = detectDuplicates(columns, rows);
  assert.equal(report.keyColumn, 'customer_id');
  assert.equal(report.exactDuplicateCount, 1);
  assert.equal(report.keyDuplicateCount, 2);
  assert.equal(report.totalDuplicateRows, 2);
});

test('detectInvalidFormats() detects currency strings, non-ISO dates, invalid dates, and bad emails', () => {
  const columns = ['contact_email', 'unit_cost', 'order_date'];
  const rows: TabularRow[] = [
    { contact_email: 'not-an-email', unit_cost: 'USD 42.50', order_date: '18/11/2026' },
    { contact_email: 'good@example.com', unit_cost: 'abc', order_date: '2026-99-99' },
  ];
  const report = detectInvalidFormats(columns, rows);
  const types = new Set(report.findings.map((f) => f.formatType));
  assert.equal(types.has('invalid_email'), true);
  assert.equal(types.has('currency_string'), true);
  assert.equal(types.has('invalid_numeric'), true);
  assert.equal(types.has('non_iso_date'), true);
  assert.equal(types.has('invalid_date'), true);
  assert.equal(report.totalInvalidCells, 5);
});

test('detectInconsistentValues() detects whitespace drift, code standardization, and mixed casing', () => {
  const columns = ['country_code', 'status', 'account_name'];
  const rows: TabularRow[] = [
    { country_code: 'uk', status: 'Approved', account_name: ' Northbridge ' },
    { country_code: 'GB', status: 'approved', account_name: 'Meridian' },
    { country_code: 'GB', status: 'Approved', account_name: 'Atlas' },
  ];
  const report = detectInconsistentValues(columns, rows);
  const types = new Set(report.findings.map((f) => f.issueType));
  assert.equal(types.has('code_standardization'), true);
  assert.equal(types.has('whitespace_drift'), true);
  assert.equal(types.has('case_inconsistency'), true);
});

test('detectAnomalies() detects negative boundaries, impossible age values, and 3x IQR outliers', () => {
  const columns = ['age_years', 'total_amount'];
  const rows: TabularRow[] = [
    { age_years: 30, total_amount: 100 },
    { age_years: 32, total_amount: 105 },
    { age_years: 35, total_amount: 110 },
    { age_years: 40, total_amount: 102 },
    { age_years: 41, total_amount: 108 },
    { age_years: 190, total_amount: -50 },
    { age_years: 29, total_amount: 99999 },
  ];
  const report = detectAnomalies(columns, rows);
  const types = new Set(report.findings.map((f) => f.anomalyType));
  assert.equal(types.has('negative_boundary'), true);
  assert.equal(types.has('domain_range'), true);
  assert.equal(types.has('statistical_outlier'), true);
});

test('calculateQualityScore() and analyzeDataset() return structured JSON and never mutate original data', () => {
  const csv = [
    'customer_id,company_name,contact_email,country_code,annual_value_usd,renewal_date',
    'CUS-1,Meridian,ops@meridian.io,US,100000,2027-01-15',
    'CUS-2, Harborline ,,uk,-4500,15/03/2027',
    'CUS-2,Harborline,ops@harborline.co.uk,GB,85000,2027-03-15',
  ].join('\n');

  const read = readDataset({ buffer: Buffer.from(csv, 'utf8'), filename: 'accounts.csv' });
  const snapshotBefore = JSON.stringify(read.originalRows);

  const analysis = analyzeDataset(read);
  const score = calculateQualityScore({
    totalRows: read.totalRows,
    totalColumns: read.totalColumns,
    missingValues: analysis.missingValues,
    duplicates: analysis.duplicates,
    invalidFormats: analysis.invalidFormats,
    inconsistentValues: analysis.inconsistentValues,
    anomalies: analysis.anomalies,
  });

  assert.equal(analysis.datasetMeta.filename, 'accounts.csv');
  assert.equal(analysis.summary.totalRecords, 3);
  assert.equal(analysis.summary.missingValues, 1);
  assert.equal(analysis.summary.duplicateRecords, 1);
  assert.equal(analysis.summary.anomalies, 1);
  assert.equal(analysis.qualityScore.overallScore, score.overallScore);
  assert.ok(score.overallScore >= 0 && score.overallScore < 100);
  assert.equal(JSON.stringify(read.originalRows), snapshotBefore);
});

test('detectInconsistentValues() detects Bangalore vs Bengaluru synonym conflict and fuzzy spelling typos', () => {
  const columns = ['city', 'department'];
  const rows: TabularRow[] = [
    { city: 'Bengaluru', department: 'Engineering' },
    { city: 'Bangalore', department: 'Engineering' },
    { city: 'Bengaluru', department: 'Enginering' },
    { city: 'Mumbai', department: 'Engineering' },
  ];

  const report = detectInconsistentValues(columns, rows);
  const synFinding = report.findings.find(
    (f) => f.column === 'city' && f.issueType === 'categorical_synonym'
  );
  assert.ok(synFinding, 'Expected Bangalore vs Bengaluru synonym finding');
  assert.deepEqual(synFinding.rowIndices, [1]);
  assert.equal(synFinding.cells[0].originalValue, 'Bangalore');
  assert.equal(synFinding.cells[0].suggestedValue, 'Bengaluru');

  const fuzzyFinding = report.findings.find(
    (f) => f.column === 'department' && f.issueType === 'fuzzy_spelling'
  );
  assert.ok(fuzzyFinding, 'Expected fuzzy typo finding for Enginering');
  assert.deepEqual(fuzzyFinding.rowIndices, [2]);
  assert.equal(fuzzyFinding.cells[0].originalValue, 'Enginering');
  assert.equal(fuzzyFinding.cells[0].suggestedValue, 'Engineering');
});

test('analyzeDataset() emits accurate 1-based row numbers and all 7 required fields across all 5 detection categories', () => {
  const csv = [
    'emp_id,full_name,email,phone,city,join_date,salary_usd',
    'E-101,Aarav Shah,aarav@company.com,+91-9876543210,Bengaluru,2025-01-10,80000',
    'E-102,Meera Nair,not-an-email,12345,Bangalore,15/02/2025,82000',
    'E-103,Rohan Verma,,+91-9876543212,Bengaluru,2025-02-30,85000',
    'E-101,Aarav Shah,aarav@company.com,+91-9876543210,Bengaluru,2025-01-10,80000',
    'E-104,Priya Menon,priya@company.com,+91-9876543214,Bengaluru,2025-04-01,83000',
    'E-105,Kabir Rao,kabir@company.com,+91-9876543215,Bengaluru,2025-05-01,950000',
  ].join('\n');

  const read = readDataset({ buffer: Buffer.from(csv, 'utf8'), filename: 'employees.csv' });
  const analysis = analyzeDataset(read);
  const detailed = analysis.detailedIssues;

  // 1. Missing value at Row 3, column email
  const missingIssue = detailed.find(
    (i) => i.issueType === 'Missing Values' && i.column === 'email'
  );
  assert.ok(missingIssue);
  assert.equal(missingIssue.rowNumber, 3);
  assert.equal(missingIssue.originalValue, '(empty)');

  // 2. Completely duplicated row at Row 4 matching Row 1
  const dupIssue = detailed.find((i) => i.issueType === 'Duplicate Records');
  assert.ok(dupIssue);
  assert.equal(dupIssue.rowNumber, 4);
  assert.equal(dupIssue.column, 'All Columns');
  assert.ok(dupIssue.description.includes('Row 1'));

  // 3. Invalid formats: email (Row 2), phone (Row 2), non-ISO date (Row 2), impossible calendar date 2025-02-30 (Row 3)
  const emailIssue = detailed.find(
    (i) => i.issueType === 'Invalid Formats' && i.column === 'email'
  );
  assert.ok(emailIssue);
  assert.equal(emailIssue.rowNumber, 2);
  assert.equal(emailIssue.originalValue, 'not-an-email');

  const phoneIssue = detailed.find(
    (i) => i.issueType === 'Invalid Formats' && i.column === 'phone'
  );
  assert.ok(phoneIssue);
  assert.equal(phoneIssue.rowNumber, 2);
  assert.equal(phoneIssue.originalValue, '12345');

  const badDateIssue = detailed.find(
    (i) => i.issueType === 'Invalid Formats' && i.column === 'join_date' && i.rowNumber === 3
  );
  assert.ok(badDateIssue);
  assert.equal(badDateIssue.originalValue, '2025-02-30');

  // 4. Inconsistent value: Bangalore at Row 2 suggesting Bengaluru
  const cityIssue = detailed.find(
    (i) => i.issueType === 'Inconsistent Values' && i.column === 'city'
  );
  assert.ok(cityIssue);
  assert.equal(cityIssue.rowNumber, 2);
  assert.equal(cityIssue.originalValue, 'Bangalore');
  assert.ok(cityIssue.suggestedAction.includes('Bengaluru'));

  // 5. IQR statistical anomaly: 950000 at Row 6
  const iqrIssue = detailed.find(
    (i) => i.issueType === 'Anomalies' && i.column === 'salary_usd'
  );
  assert.ok(iqrIssue);
  assert.equal(iqrIssue.rowNumber, 6);
  assert.equal(iqrIssue.originalValue, '950000');
  assert.ok(iqrIssue.description.includes('IQR'));

  // Every detailed issue must populate all 7 required fields
  for (const item of detailed) {
    assert.ok(item.issueType.length > 0);
    assert.ok(item.column.length > 0);
    assert.ok(Number.isInteger(item.rowNumber) && item.rowNumber >= 1 && item.rowNumber <= 6);
    assert.ok(item.originalValue.length > 0);
    assert.ok(item.description.length > 0);
    assert.ok(['Critical', 'Warning', 'Info'].includes(item.severity));
    assert.ok(item.suggestedAction.length > 0);
  }
});
