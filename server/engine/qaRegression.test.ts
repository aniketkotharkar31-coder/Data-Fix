import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import * as XLSX from 'xlsx';
import Papa from 'papaparse';
import {
  analyzeDataset,
  applyApprovedRepairSuggestions,
  buildCleanedCsvExport,
  buildCleanedExcelExport,
  buildDataQualityReportExcel,
  buildDataQualityReportPayload,
  buildModificationHistoryExcel,
  detectAnomalies,
  detectDuplicates,
  detectInconsistentValues,
  detectInvalidFormats,
  generateRepairSuggestions,
  readDataset,
  validateDatasetRepairs,
} from './index.ts';
import { createApiRouter } from '../routes/api.ts';
import { parseCsvContent, parseXlsxBuffer } from '../../src/utils/fileUploadValidation.ts';

test('QA #1: CSV headers with leading/trailing spaces & duplicates preserve all cell values on server and client', () => {
  const csv = [
    '\uFEFF customer_id , email , amount , note , note ',
    'C-1,alice@example.com,100,first,second',
    'C-2,bob@example.com,200,third,fourth',
  ].join('\n');

  const serverRead = readDataset({
    filename: 'spaced_headers.csv',
    buffer: Buffer.from(csv, 'utf8'),
  });
  assert.deepEqual(serverRead.columns, ['customer_id', 'email', 'amount', 'note', 'note_2']);
  assert.equal(serverRead.rows[0].customer_id, 'C-1');
  assert.equal(serverRead.rows[0].email, 'alice@example.com');
  assert.equal(serverRead.rows[0].amount, 100);
  assert.equal(serverRead.rows[0].note, 'first');
  assert.equal(serverRead.rows[0].note_2, 'second');

  const clientRead = parseCsvContent(csv, 'spaced_headers.csv', Buffer.byteLength(csv));
  assert.deepEqual(clientRead.columns, serverRead.columns);
  assert.equal(clientRead.originalRows[1].customer_id, 'C-2');
  assert.equal(clientRead.originalRows[1].note_2, 'fourth');
});

test('QA #2: Native Excel Date cells are parsed to ISO YYYY-MM-DD and NOT falsely flagged as invalid dates', () => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['order_id', 'order_date', 'unit_price'],
    ['ORD-1', new Date(Date.UTC(2026, 0, 15)), 120.5],
    ['ORD-2', new Date(Date.UTC(2026, 2, 22)), 145.0],
    ['ORD-3', '2026/04/05', '$89.50'],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'Orders');
  const xlsxBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

  const serverRead = readDataset({
    filename: 'native_dates.xlsx',
    buffer: xlsxBuffer,
  });
  assert.equal(serverRead.rows[0].order_date, '2026-01-15');
  assert.equal(serverRead.rows[1].order_date, '2026-03-22');
  assert.equal(serverRead.rows[2].order_date, '2026/04/05');

  const clientRead = parseXlsxBuffer(xlsxBuffer, 'native_dates.xlsx', xlsxBuffer.byteLength);
  assert.equal(clientRead.originalRows[0].order_date, '2026-01-15');
  assert.equal(clientRead.originalRows[1].order_date, '2026-03-22');

  const analysis = analyzeDataset(serverRead);
  // Only row 3's '2026/04/05' should be flagged as non_iso_date, NOT rows 1 or 2
  const dateFindings = analysis.invalidFormats.findings.filter((f) => f.column === 'order_date');
  assert.equal(dateFindings.length, 1);
  assert.equal(dateFindings[0].formatType, 'non_iso_date');
  assert.deepEqual(dateFindings[0].rowIndices, [2]);
  assert.equal(dateFindings[0].cells[0].suggestedValue, '2026-04-05');
});

test('QA #3: Currency-formatted strings ($112.00, USD 84.50, -$50.25) generate actionable Normalize Numeric Format repairs', () => {
  const rows = [
    { order_id: 'O-1', unit_cost: 'USD 84.50', order_date: '2026/05/09' },
    { order_id: 'O-2', unit_cost: '$112.00', order_date: '15/06/2026' },
    { order_id: 'O-3', unit_cost: '-$50.25', order_date: '2026-07-01' },
    { order_id: 'O-4', unit_cost: 95.0, order_date: '2026-07-02' },
  ];

  const analysis = analyzeDataset({
    filename: 'currency_test.csv',
    columns: ['order_id', 'unit_cost', 'order_date'],
    rows,
  });

  const suggestions = generateRepairSuggestions('ds-curr', 'currency_test.csv', analysis, rows);
  const costFormatSuggestions = suggestions.filter(
    (s) => s.column === 'unit_cost' && s.issueType === 'Invalid Formats'
  );
  assert.equal(costFormatSuggestions.length, 3);
  assert.ok(costFormatSuggestions.every((s) => !s.manualReviewOnly));
  assert.ok(costFormatSuggestions.every((s) => s.repairMethod === 'Normalize Numeric Format'));
  assert.equal(costFormatSuggestions[0].proposedRawValue, 84.5);
  assert.equal(costFormatSuggestions[1].proposedRawValue, 112);
  assert.equal(costFormatSuggestions[2].proposedRawValue, -50.25);

  // Negative unit_cost (-$50.25) is also flagged for manual review as an anomaly
  const costAnomalies = suggestions.filter(
    (s) => s.column === 'unit_cost' && s.issueType === 'Anomalies'
  );
  assert.equal(costAnomalies.length, 1);
  assert.equal(costAnomalies[0].manualReviewOnly, true);

  const dateSuggestions = suggestions.filter((s) => s.column === 'order_date');
  assert.equal(dateSuggestions.length, 2);
  assert.equal(dateSuggestions[0].proposedRawValue, '2026-05-09');
  assert.equal(dateSuggestions[1].proposedRawValue, '2026-06-15');
});

test('QA #4: Country column with full names normalizes USA -> United States without uppercasing to UNITED STATES', () => {
  const rows = [
    { id: '1', country: 'United States', city: 'Bengaluru', country_code: 'US' },
    { id: '2', country: 'USA', city: 'Bangalore', country_code: 'uk' },
    { id: '3', country: 'United States', city: 'Bengaluru', country_code: 'GB' },
  ];

  const report = detectInconsistentValues(['id', 'country', 'city', 'country_code'], rows);
  const countryFinding = report.findings.find((f) => f.column === 'country');
  assert.ok(countryFinding, 'Expected country synonym inconsistency finding');
  assert.equal(countryFinding.issueType, 'categorical_synonym');
  assert.equal(countryFinding.cells[0].originalValue, 'USA');
  assert.equal(countryFinding.cells[0].suggestedValue, 'United States');

  // country_code should STILL be normalized as ISO code ('uk' -> 'GB')
  const codeFinding = report.findings.find((f) => f.column === 'country_code');
  assert.ok(codeFinding, 'Expected country_code ISO standardization finding');
  assert.equal(codeFinding.issueType, 'code_standardization');
  assert.equal(codeFinding.cells[0].suggestedValue, 'GB');

  const cityFinding = report.findings.find((f) => f.column === 'city');
  assert.ok(cityFinding);
  assert.equal(cityFinding.cells[0].suggestedValue, 'Bengaluru');
});

test('QA #5: Anomaly detector catches constant-majority (IQR === 0) outliers and comma-formatted numeric strings', () => {
  const rows = [
    { item: 'A', unit_price: 100, annual_revenue: '50,000' },
    { item: 'B', unit_price: 100, annual_revenue: '52,000' },
    { item: 'C', unit_price: 100, annual_revenue: '49,000' },
    { item: 'D', unit_price: 100, annual_revenue: '51,500' },
    { item: 'E', unit_price: 100, annual_revenue: '50,500' },
    { item: 'F', unit_price: 99999, annual_revenue: '9,950,000' },
  ];

  const report = detectAnomalies(['item', 'unit_price', 'annual_revenue'], rows);
  const priceFinding = report.findings.find((f) => f.column === 'unit_price');
  assert.ok(priceFinding, 'Expected constant-majority outlier detection on unit_price');
  assert.deepEqual(priceFinding.rowIndices, [5]);
  assert.equal(priceFinding.cells[0].originalValue, '99999');

  const revFinding = report.findings.find((f) => f.column === 'annual_revenue');
  assert.ok(revFinding, 'Expected IQR outlier detection on comma-formatted annual_revenue');
  assert.deepEqual(revFinding.rowIndices, [5]);
});

test('QA #6: Duplicate detector finds primary-key duplicates in non-first ID columns and ignores country_code/zip_code', () => {
  // Primary ID in column 2 (index 1)
  const rowsWithSecondColId = [
    { created_at: '2026-01-01', customer_id: 'CUS-1', name: 'Alpha' },
    { created_at: '2026-01-02', customer_id: 'CUS-2', name: 'Beta' },
    { created_at: '2026-01-03', customer_id: 'CUS-2', name: 'Beta Updated' },
    { created_at: '2026-01-04', customer_id: 'CUS-3', name: 'Gamma' },
  ];
  const dupReport = detectDuplicates(
    ['created_at', 'customer_id', 'name'],
    rowsWithSecondColId
  );
  assert.equal(dupReport.keyColumn, 'customer_id');
  assert.equal(dupReport.keyDuplicateCount, 1);
  assert.deepEqual(dupReport.keyDuplicateRowIndices, [2]);

  // country_code in column 0 must NOT trigger false-positive duplicate key alerts
  const rowsWithCountryCodeFirst = [
    { country_code: 'US', company: 'Alpha', revenue: 100 },
    { country_code: 'US', company: 'Beta', revenue: 200 },
    { country_code: 'GB', company: 'Gamma', revenue: 300 },
  ];
  const noFalseDup = detectDuplicates(
    ['country_code', 'company', 'revenue'],
    rowsWithCountryCodeFirst
  );
  assert.equal(noFalseDup.keyColumn, null);
  assert.equal(noFalseDup.totalDuplicateRows, 0);
});

test('QA #7: End-to-end API pipeline for Excel upload -> repair -> validation -> audit -> reset -> exports', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter());

  const server = app.listen(0);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // Build a realistic .xlsx file with all 5 issue categories + native Excel dates
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ['customer_id', 'customer_name', 'email', 'city', 'country', 'amount', 'signup_date'],
      ['CUS-1', 'Alice Corp', 'alice@corp.com', 'Bengaluru', 'United States', 1000, new Date(Date.UTC(2026, 0, 10))],
      ['CUS-2', 'Bob Labs', 'bobgmail.com', 'Bangalore', 'USA', '$1,250.50', '2026/02/14'],
      ['CUS-2', 'Bob Labs', 'bobgmail.com', 'Bangalore', 'USA', '$1,250.50', '2026/02/14'], // exact duplicate
      ['CUS-3', 'Carol Inc', 'carol@inc.io', 'Bengaluru', 'United States', null, '2026-03-01'], // missing numeric
      ['CUS-4', 'Delta Co', 'delta@co.com', 'Bengaluru', 'United States', 1100, '2026-03-05'],
      ['CUS-5', 'Echo Ltd', 'echo@ltd.io', 'Bengaluru', 'United States', 995000, '2026-03-10'], // IQR anomaly
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Customers');
    const xlsxBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(xlsxBuf)], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
      'qa_e2e_customers.xlsx'
    );

    const uploadRes = await fetch(`${baseUrl}/api/datasets/upload`, {
      method: 'POST',
      body: form,
    });
    assert.equal(uploadRes.status, 201);
    const uploaded = (await uploadRes.json()) as {
      dataset: { id: string; rows: number; qualityScore: number };
      analysis: { detailedIssues: Array<{ issueType: string; column: string; rowNumber: number }> };
    };
    const dsId = uploaded.dataset.id;
    assert.equal(uploaded.dataset.rows, 6);

    const detectedTypes = new Set(uploaded.analysis.detailedIssues.map((i) => i.issueType));
    assert.ok(detectedTypes.has('Missing Values'));
    assert.ok(detectedTypes.has('Duplicate Records'));
    assert.ok(detectedTypes.has('Invalid Formats'));
    assert.ok(detectedTypes.has('Inconsistent Values'));
    assert.ok(detectedTypes.has('Anomalies'));

    // Fetch repair suggestions and approve all actionable suggestions
    const repairsRes = await fetch(`${baseUrl}/api/repairs?datasetId=${dsId}`);
    const repairsData = (await repairsRes.json()) as {
      suggestions: Array<{ id: string; manualReviewOnly: boolean; column: string; operationType: string }>;
    };
    const actionable = repairsData.suggestions.filter((s) => !s.manualReviewOnly);
    const manualOnly = repairsData.suggestions.filter((s) => s.manualReviewOnly);
    assert.ok(actionable.length >= 5, `Expected >= 5 actionable repairs, got ${actionable.length}`);
    assert.ok(
      manualOnly.some((s) => s.column === 'email'),
      'Invalid email must stay manual review only'
    );
    assert.ok(
      manualOnly.some((s) => s.column === 'amount'),
      'IQR anomaly must stay manual review only'
    );

    const approveRes = await fetch(`${baseUrl}/api/datasets/${dsId}/repairs/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        approvals: actionable.map((s) => ({ suggestionId: s.id })),
      }),
    });
    assert.equal(approveRes.status, 200);
    const approved = (await approveRes.json()) as {
      dataset: { rows: number; qualityScore: number };
      validationReport: {
        issuesSuccessfullyRepaired: number;
        failedRepairs: number;
        originalDuplicateRecords: number;
        remainingDuplicateRecords: number;
        originalMissingValues: number;
        remainingMissingValues: number;
        qualityScoreImprovement: number;
      };
    };

    assert.equal(approved.dataset.rows, 5, 'Duplicate row should be removed');
    assert.equal(approved.validationReport.failedRepairs, 0, 'Zero failed repairs expected');
    assert.equal(approved.validationReport.remainingDuplicateRecords, 0);
    assert.equal(approved.validationReport.remainingMissingValues, 0);
    assert.ok(approved.validationReport.qualityScoreImprovement > 0);

    // Download Cleaned CSV & Cleaned Excel & Quality Report Excel & Modification History Excel
    const csvRes = await fetch(`${baseUrl}/api/datasets/${dsId}/export?format=csv`);
    assert.equal(csvRes.status, 200);
    const csvBytes = Buffer.from(await csvRes.arrayBuffer());
    assert.equal(csvBytes[0], 0xef);
    assert.equal(csvBytes[1], 0xbb);
    assert.equal(csvBytes[2], 0xbf);
    const csvText = csvBytes.subarray(3).toString('utf8');
    const parsedCsv = Papa.parse<Record<string, string>>(csvText, {
      header: true,
      skipEmptyLines: true,
    });
    assert.equal(parsedCsv.data.length, 5);
    assert.equal(parsedCsv.data[1].city, 'Bengaluru');
    assert.equal(parsedCsv.data[1].country, 'United States');
    assert.equal(parsedCsv.data[1].amount, '1250.5');
    assert.equal(parsedCsv.data[1].signup_date, '2026-02-14');
    // Unapproved manual-review anomaly & invalid email must remain untouched
    assert.equal(parsedCsv.data[1].email, 'bobgmail.com');
    assert.equal(parsedCsv.data[4].amount, '995000');

    const xlsxExportRes = await fetch(`${baseUrl}/api/datasets/${dsId}/export?format=xlsx`);
    assert.equal(xlsxExportRes.status, 200);
    const exportedWb = XLSX.read(Buffer.from(await xlsxExportRes.arrayBuffer()), { type: 'buffer' });
    assert.deepEqual(exportedWb.SheetNames, ['CleanedData']);

    const qrRes = await fetch(`${baseUrl}/api/datasets/${dsId}/export/quality-report?format=xlsx`);
    assert.equal(qrRes.status, 200);
    const qrWb = XLSX.read(Buffer.from(await qrRes.arrayBuffer()), { type: 'buffer' });
    assert.deepEqual(qrWb.SheetNames, [
      'Summary',
      'Detected Issues',
      'Applied Repairs',
      'Remaining Issues',
      'Validation Results',
    ]);

    const modExportRes = await fetch(`${baseUrl}/api/datasets/${dsId}/export/modifications?format=xlsx`);
    assert.equal(modExportRes.status, 200);
    const modWb = XLSX.read(Buffer.from(await modExportRes.arrayBuffer()), { type: 'buffer' });
    assert.deepEqual(modWb.SheetNames, ['Modification History']);

    // Test Restore Original logs accurate prior row count (5 -> 6) and marks audit records Reverted
    const resetRes = await fetch(`${baseUrl}/api/datasets/${dsId}/reset`, { method: 'POST' });
    assert.equal(resetRes.status, 200);
    const resetData = (await resetRes.json()) as { dataset: { rows: number } };
    assert.equal(resetData.dataset.rows, 6);

    const repairsAfterReset = (await (
      await fetch(`${baseUrl}/api/repairs?datasetId=${dsId}`)
    ).json()) as {
      modificationHistory: Array<{ action: string; originalValue: string; newValue: string }>;
    };
    const restoreLog = repairsAfterReset.modificationHistory.find(
      (h) => h.action === 'Restored Original'
    );
    assert.ok(restoreLog);
    assert.equal(restoreLog.originalValue, '5 current rows');
    assert.equal(restoreLog.newValue, '6 original rows');

    const auditAfterReset = (await (
      await fetch(`${baseUrl}/api/audit?datasetId=${dsId}`)
    ).json()) as {
      modifications: Array<{ validationStatus: string }>;
    };
    assert.ok(auditAfterReset.modifications.length > 0);
    assert.ok(
      auditAfterReset.modifications.every((m) => m.validationStatus === 'Reverted')
    );
  } finally {
    server.close();
  }
});

// Keep imports exercised cleanly
void applyApprovedRepairSuggestions;
void buildCleanedCsvExport;
void buildCleanedExcelExport;
void buildDataQualityReportExcel;
void buildDataQualityReportPayload;
void buildModificationHistoryExcel;
void detectInvalidFormats;
void validateDatasetRepairs;
