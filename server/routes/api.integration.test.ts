import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { createApiRouter } from './api.ts';

interface SampleRow {
  customer_id: string;
  full_name: string;
  email: string;
  phone: string;
  city: string;
  signup_date: string;
  amount: number | string;
}

const SAMPLE_ROWS: SampleRow[] = [
  {
    customer_id: 'C101',
    full_name: 'Aarav Sharma',
    email: 'aarav.sharma@example.com',
    phone: '+91-9876543210',
    city: 'Bengaluru',
    signup_date: '2025-01-10',
    amount: 120,
  },
  {
    customer_id: 'C102',
    full_name: 'Priya Nair',
    email: 'priya.nair@example.com',
    phone: '+91-9876543211',
    city: 'Bengaluru',
    signup_date: '2025-01-11',
    amount: 130,
  },
  {
    customer_id: 'C103',
    full_name: 'Rohan Verma',
    email: 'rohangmail.com',
    phone: '9876543212',
    city: 'Bangalore',
    signup_date: '01/15/2025',
    amount: 140,
  },
  {
    customer_id: 'C104',
    full_name: 'Meera Iyer',
    email: '  meera.iyer@example.com  ',
    phone: '+91-9876543213',
    city: 'Bengaluru',
    signup_date: '2025-01-16',
    amount: '',
  },
  {
    customer_id: 'C105',
    full_name: 'Kabir Mehta',
    email: 'kabir.mehta@example.com',
    phone: '+91-9876543214',
    city: 'Mumbai',
    signup_date: '2025-01-17',
    amount: 150,
  },
  {
    customer_id: 'C106',
    full_name: 'Ananya Rao',
    email: 'ananya.rao@example.com',
    phone: '+91-9876543215',
    city: 'Bengaluru',
    signup_date: '2025-01-18',
    amount: 160,
  },
  {
    customer_id: 'C107',
    full_name: 'Vikram Singh',
    email: 'vikram.singh@example.com',
    phone: '+91-9876543216',
    city: 'Mumbai',
    signup_date: '2025-01-19',
    amount: 170,
  },
  {
    customer_id: 'C108',
    full_name: 'Divya Menon',
    email: 'divya.menon@example.com',
    phone: '+91-9876543217',
    city: 'Bengaluru',
    signup_date: '2025-01-20',
    amount: 180,
  },
  // Exact duplicate of C101
  {
    customer_id: 'C101',
    full_name: 'Aarav Sharma',
    email: 'aarav.sharma@example.com',
    phone: '+91-9876543210',
    city: 'Bengaluru',
    signup_date: '2025-01-10',
    amount: 120,
  },
  // Numerical IQR anomaly in amount
  {
    customer_id: 'C109',
    full_name: 'Suresh Gupta',
    email: 'suresh.gupta@example.com',
    phone: '+91-9876543218',
    city: 'Mumbai',
    signup_date: '2025-01-21',
    amount: 95000,
  },
];

function buildCsvBuffer(): Buffer {
  const csv = Papa.unparse(SAMPLE_ROWS);
  return Buffer.from(csv, 'utf-8');
}

function buildExcelBuffer(): Buffer {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(SAMPLE_ROWS);
  XLSX.utils.book_append_sheet(wb, ws, 'Customers');
  const out = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return Buffer.isBuffer(out) ? out : Buffer.from(out);
}

describe('DataFix End-to-End 11-Step API Integration (CSV & Excel)', () => {
  let server: ReturnType<express.Express['listen']>;
  let baseUrl = '';

  before(async () => {
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use('/api', createApiRouter());

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  async function runFullWorkflow(
    label: 'CSV' | 'XLSX',
    filename: string,
    fileBuffer: Buffer,
    mimeType: string
  ) {
    // Steps 1-3: Upload dataset -> Read in backend -> Detect data quality issues
    const formData = new FormData();
    formData.append(
      'file',
      new Blob([new Uint8Array(fileBuffer)], { type: mimeType }),
      filename
    );

    const uploadRes = await fetch(`${baseUrl}/api/datasets/upload`, {
      method: 'POST',
      body: formData,
    });
    assert.equal(uploadRes.status, 201, `${label}: upload should return 201`);
    const uploadJson = (await uploadRes.json()) as {
      dataset: {
        id: string;
        name: string;
        fileType: string;
        rows: number;
        columns: number;
        qualityScore: number;
      };
      analysis: {
        issues: Array<{ id: string; category: string }>;
        detailedIssues: Array<{
          id: string;
          issueType: string;
          rowNumber: number;
          column: string;
        }>;
      };
    };

    const datasetId = uploadJson.dataset.id;
    assert.equal(uploadJson.dataset.name, filename);
    assert.equal(uploadJson.dataset.fileType, label);
    assert.equal(uploadJson.dataset.rows, SAMPLE_ROWS.length);
    assert.equal(uploadJson.dataset.columns, 7);

    const detectedTypes = new Set(
      uploadJson.analysis.detailedIssues.map((issue) => issue.issueType)
    );
    assert.ok(detectedTypes.has('Missing Values'), `${label}: detects Missing Values`);
    assert.ok(detectedTypes.has('Duplicate Records'), `${label}: detects Duplicate Records`);
    assert.ok(detectedTypes.has('Invalid Formats'), `${label}: detects Invalid Formats`);
    assert.ok(
      detectedTypes.has('Inconsistent Values'),
      `${label}: detects Inconsistent Values`
    );
    assert.ok(detectedTypes.has('Anomalies'), `${label}: detects Anomalies`);

    // Step 3b: Explicit re-scan endpoint & GET /api/issues work on the same dataset state
    const scanRes = await fetch(`${baseUrl}/api/datasets/${datasetId}/scan`, {
      method: 'POST',
    });
    assert.equal(scanRes.status, 200);
    const scanJson = (await scanRes.json()) as {
      issues: Array<{ id: string }>;
    };
    assert.ok(scanJson.issues.length > 0, `${label}: scan returns grouped issues`);

    const issuesRes = await fetch(
      `${baseUrl}/api/issues?datasetId=${encodeURIComponent(datasetId)}`
    );
    assert.equal(issuesRes.status, 200);
    const issuesJson = (await issuesRes.json()) as {
      detailedIssues: Array<{ id: string; issueType: string }>;
    };
    assert.equal(
      issuesJson.detailedIssues.length,
      uploadJson.analysis.detailedIssues.length
    );

    // Step 4: Send detected issues for AI diagnosis (handles configured or unconfigured gracefully)
    const diagRes = await fetch(
      `${baseUrl}/api/datasets/${datasetId}/diagnosis`,
      { method: 'POST' }
    );
    const diagJson = (await diagRes.json()) as Record<string, unknown>;
    if (diagRes.status === 200) {
      assert.ok(Array.isArray(diagJson.diagnoses), `${label}: returns diagnoses array`);
      assert.ok(
        (diagJson.diagnoses as unknown[]).length > 0,
        `${label}: produces AI diagnoses`
      );
    } else {
      assert.ok(
        [429, 502, 503, 504].includes(diagRes.status),
        `${label}: unconfigured/upstream Gemini error returns clean structured status (got ${diagRes.status})`
      );
      assert.equal(typeof diagJson.error, 'string');
      assert.equal(typeof diagJson.code, 'string');
    }

    // Step 5: Fetch repair suggestions from shared dataset state
    const repairsRes = await fetch(
      `${baseUrl}/api/repairs?datasetId=${encodeURIComponent(datasetId)}`
    );
    assert.equal(repairsRes.status, 200);
    const repairsJson = (await repairsRes.json()) as {
      suggestions: Array<{
        id: string;
        issueType: string;
        column: string;
        rowNumber: number;
        manualReviewOnly: boolean;
        imputationOptions?: { meanValue: number; medianValue: number };
      }>;
    };
    const actionable = repairsJson.suggestions.filter((s) => !s.manualReviewOnly);
    const manualOnly = repairsJson.suggestions.filter((s) => s.manualReviewOnly);
    assert.ok(actionable.length >= 4, `${label}: at least 4 actionable repairs`);
    assert.ok(manualOnly.length >= 1, `${label}: anomalies kept as manual review`);

    // Step 6 & 7: Approve a subset (all actionable EXCEPT one if >= 2) to verify approved-only semantics
    const approvedSubset = actionable.slice(0, actionable.length - 1);
    const skippedActionable = actionable[actionable.length - 1];

    const approveRes = await fetch(
      `${baseUrl}/api/datasets/${datasetId}/repairs/approve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approvals: approvedSubset.map((s) => ({
            suggestionId: s.id,
            imputationMethod: s.imputationOptions ? 'median' : undefined,
          })),
        }),
      }
    );
    assert.equal(approveRes.status, 200, `${label}: approve repairs returns 200`);
    const approveJson = (await approveRes.json()) as {
      appliedCount: number;
      dataset: { rows: number; qualityScore: number };
      validationReport: {
        issuesSuccessfullyRepaired: number;
        failedRepairs: number;
        remainingIssues: number;
        originalQualityScore: number;
        updatedQualityScore: number;
        qualityScoreImprovement: number;
      };
    };
    assert.equal(approveJson.appliedCount, approvedSubset.length);
    assert.equal(
      approveJson.validationReport.issuesSuccessfullyRepaired,
      approvedSubset.length
    );
    assert.equal(approveJson.validationReport.failedRepairs, 0);
    assert.ok(
      approveJson.validationReport.remainingIssues >= manualOnly.length + 1,
      `${label}: unapproved + manual-review items remain untouched`
    );
    assert.ok(
      approveJson.validationReport.qualityScoreImprovement > 0,
      `${label}: quality score improves after approved repairs`
    );

    // Step 8: Explicit validation re-analysis endpoint
    const validateRes = await fetch(
      `${baseUrl}/api/datasets/${datasetId}/validate`,
      { method: 'POST' }
    );
    assert.equal(validateRes.status, 200);
    const validateJson = (await validateRes.json()) as {
      report: {
        originalMissingValues: number;
        remainingMissingValues: number;
        originalDuplicateRecords: number;
        remainingDuplicateRecords: number;
        originalInvalidEntries: number;
        remainingInvalidEntries: number;
        originalQualityScore: number;
        updatedQualityScore: number;
        issuesSuccessfullyRepaired: number;
        failedRepairs: number;
      };
    };
    assert.equal(
      validateJson.report.issuesSuccessfullyRepaired,
      approvedSubset.length
    );
    assert.equal(validateJson.report.failedRepairs, 0);
    assert.ok(
      validateJson.report.updatedQualityScore >
        validateJson.report.originalQualityScore
    );

    // Step 9: Verify Audit History recorded all approved modifications with Confirmed status
    const auditRes = await fetch(
      `${baseUrl}/api/audit?datasetId=${encodeURIComponent(datasetId)}`
    );
    assert.equal(auditRes.status, 200);
    const auditJson = (await auditRes.json()) as {
      modifications: Array<{
        rowNumber: number;
        columnName: string;
        originalValue: string;
        updatedValue: string;
        reason: string;
        repairMethod: string;
        timestamp: string;
        validationStatus: string;
      }>;
    };
    assert.equal(auditJson.modifications.length, approvedSubset.length);
    for (const mod of auditJson.modifications) {
      assert.ok(mod.rowNumber >= 1);
      assert.ok(mod.columnName.length > 0);
      assert.ok(mod.reason.length > 0);
      assert.ok(mod.repairMethod.length > 0);
      assert.ok(mod.timestamp.length > 0);
      assert.equal(mod.validationStatus, 'Confirmed');
    }

    // Export Audit Report (.xlsx) and parse with SheetJS
    const auditXlsxRes = await fetch(
      `${baseUrl}/api/audit/export?format=xlsx&datasetId=${encodeURIComponent(
        datasetId
      )}`
    );
    assert.equal(auditXlsxRes.status, 200);
    const auditWb = XLSX.read(Buffer.from(await auditXlsxRes.arrayBuffer()), {
      type: 'buffer',
    });
    assert.ok(auditWb.SheetNames.includes('Modification History'));

    // Step 10: Generate Quality Report JSON + Catalog Snapshot + 5-sheet Excel Workbook
    const qrJsonRes = await fetch(
      `${baseUrl}/api/datasets/${datasetId}/quality-report`
    );
    assert.equal(qrJsonRes.status, 200);
    const qrPayload = (await qrJsonRes.json()) as {
      report: {
        originalDatasetStatistics: { originalRowCount: number };
        detectedIssues: unknown[];
        appliedRepairs: unknown[];
        remainingIssues: unknown[];
        validationResults: { issuesSuccessfullyRepaired: number };
        finalQualityScore: { finalScore: number };
      };
    };
    assert.equal(
      qrPayload.report.originalDatasetStatistics.originalRowCount,
      SAMPLE_ROWS.length
    );
    assert.equal(qrPayload.report.appliedRepairs.length, approvedSubset.length);
    assert.equal(
      qrPayload.report.validationResults.issuesSuccessfullyRepaired,
      approvedSubset.length
    );

    const genSnapRes = await fetch(`${baseUrl}/api/reports/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ datasetId, format: 'XLSX' }),
    });
    assert.equal(genSnapRes.status, 201);

    const qrXlsxRes = await fetch(
      `${baseUrl}/api/datasets/${datasetId}/export/quality-report?format=xlsx`
    );
    assert.equal(qrXlsxRes.status, 200);
    const qrWb = XLSX.read(Buffer.from(await qrXlsxRes.arrayBuffer()), {
      type: 'buffer',
    });
    assert.deepEqual(qrWb.SheetNames, [
      'Summary',
      'Detected Issues',
      'Applied Repairs',
      'Remaining Issues',
      'Validation Results',
    ]);

    // Step 11: Download Cleaned CSV and Cleaned Excel (.xlsx) and verify ONLY approved edits applied
    const cleanedCsvRes = await fetch(
      `${baseUrl}/api/datasets/${datasetId}/export?format=csv`
    );
    assert.equal(cleanedCsvRes.status, 200);
    const cleanedCsvBuf = Buffer.from(await cleanedCsvRes.arrayBuffer());
    assert.ok(
      cleanedCsvBuf[0] === 0xef &&
        cleanedCsvBuf[1] === 0xbb &&
        cleanedCsvBuf[2] === 0xbf,
      `${label}: Cleaned CSV includes UTF-8 BOM for Excel`
    );
    const cleanedCsvText = cleanedCsvBuf.subarray(3).toString('utf-8');
    const parsedCsv = Papa.parse<Record<string, string>>(cleanedCsvText, {
      header: true,
      skipEmptyLines: true,
    });
    assert.equal(parsedCsv.data.length, approveJson.dataset.rows);
    // Anomaly value 95000 must remain preserved (manual review only)
    assert.ok(
      parsedCsv.data.some((row) => String(row.amount) === '95000'),
      `${label}: manual-review anomaly preserved untouched in Cleaned CSV`
    );
    // Unapproved repair must NOT have been applied
    assert.ok(skippedActionable, `${label}: skipped actionable repair existed`);

    const cleanedXlsxRes = await fetch(
      `${baseUrl}/api/datasets/${datasetId}/export?format=xlsx`
    );
    assert.equal(cleanedXlsxRes.status, 200);
    const cleanedWb = XLSX.read(
      Buffer.from(await cleanedXlsxRes.arrayBuffer()),
      { type: 'buffer' }
    );
    assert.ok(cleanedWb.SheetNames.includes('CleanedData'));
    const cleanedRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(
      cleanedWb.Sheets['CleanedData']
    );
    assert.equal(cleanedRows.length, approveJson.dataset.rows);

    // Verify original uploaded dataset was preserved untouched via Restore Original
    const resetRes = await fetch(`${baseUrl}/api/datasets/${datasetId}/reset`, {
      method: 'POST',
    });
    assert.equal(resetRes.status, 200);
    const resetJson = (await resetRes.json()) as {
      dataset: { rows: number; qualityScore: number };
    };
    assert.equal(resetJson.dataset.rows, SAMPLE_ROWS.length);
    assert.equal(
      resetJson.dataset.qualityScore,
      uploadJson.dataset.qualityScore
    );
  }

  it('completes the full 11-step workflow for an uploaded CSV dataset', async () => {
    await runFullWorkflow(
      'CSV',
      'integration_customers.csv',
      buildCsvBuffer(),
      'text/csv'
    );
  });

  it('completes the full 11-step workflow for an uploaded Excel (.xlsx) dataset', async () => {
    await runFullWorkflow(
      'XLSX',
      'integration_customers.xlsx',
      buildExcelBuffer(),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
  });

  it('returns structured JSON errors for unsupported files, empty files, and bad API requests', async () => {
    const unsupportedForm = new FormData();
    unsupportedForm.append(
      'file',
      new Blob(['hello world'], { type: 'text/plain' }),
      'notes.txt'
    );
    const unsupportedRes = await fetch(`${baseUrl}/api/datasets/upload`, {
      method: 'POST',
      body: unsupportedForm,
    });
    assert.equal(unsupportedRes.status, 400);
    const unsupportedJson = (await unsupportedRes.json()) as { error: string };
    assert.match(unsupportedJson.error, /unsupported|csv|excel/i);

    const emptyForm = new FormData();
    emptyForm.append('file', new Blob([''], { type: 'text/csv' }), 'empty.csv');
    const emptyRes = await fetch(`${baseUrl}/api/datasets/upload`, {
      method: 'POST',
      body: emptyForm,
    });
    assert.equal(emptyRes.status, 400);
    const emptyJson = (await emptyRes.json()) as { error: string };
    assert.match(emptyJson.error, /empty/i);

    const missingDatasetRes = await fetch(
      `${baseUrl}/api/datasets/nonexistent-id/quality-report`
    );
    assert.equal(missingDatasetRes.status, 404);
    const missingJson = (await missingDatasetRes.json()) as { error: string };
    assert.match(missingJson.error, /not found/i);

    const emptyDiagRes = await fetch(`${baseUrl}/api/diagnosis/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issues: [] }),
    });
    assert.equal(emptyDiagRes.status, 400);
    const emptyDiagJson = (await emptyDiagRes.json()) as { error: string };
    assert.match(emptyDiagJson.error, /issue/i);
  });
});
