import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {
  PREVIEW_ROW_LIMIT,
  UploadValidationError,
  createSampleCsvUploadFile,
  createSampleXlsxUploadFile,
  formatFileSize,
  parseAndValidateUploadedFile,
  parseCsvContent,
  parseXlsxBuffer,
  validateUploadFileMeta,
} from './fileUploadValidation';

test('formatFileSize formats bytes, kilobytes, and megabytes accurately', () => {
  assert.equal(formatFileSize(0), '0 B');
  assert.equal(formatFileSize(512), '512 B');
  assert.equal(formatFileSize(1536), '1.5 KB');
  assert.equal(formatFileSize(2 * 1024 * 1024), '2.00 MB');
});

test('validateUploadFileMeta rejects unsupported file extensions including .txt, .json, .pdf, .xls, and extensionless files', () => {
  for (const badName of ['notes.txt', 'data.json', 'report.pdf', 'legacy.xls', 'README']) {
    assert.throws(
      () => validateUploadFileMeta({ name: badName, size: 128 }),
      (err: unknown) =>
        err instanceof UploadValidationError && err.code === 'UNSUPPORTED_TYPE'
    );
  }
});

test('validateUploadFileMeta rejects 0-byte empty files', () => {
  assert.throws(
    () => validateUploadFileMeta({ name: 'empty.csv', size: 0 }),
    (err: unknown) =>
      err instanceof UploadValidationError && err.code === 'EMPTY_FILE'
  );
});

test('parseCsvContent parses actual row/column counts, slices 10-row preview, and preserves original rows unchanged', async () => {
  const file = createSampleCsvUploadFile();
  const parsed = await parseAndValidateUploadedFile(file);

  assert.equal(parsed.name, 'customer_accounts_q4.csv');
  assert.equal(parsed.fileType, 'CSV');
  assert.equal(parsed.fileSizeBytes, file.size);
  assert.equal(parsed.totalRows, 12);
  assert.equal(parsed.totalColumns, 6);
  assert.equal(parsed.previewRows.length, PREVIEW_ROW_LIMIT);
  assert.equal(parsed.originalRows.length, 12);

  // Verify original dirty values are preserved untouched (leading/trailing spaces, null, duplicate keys, negative value)
  assert.equal(parsed.originalRows[1].contact_email, null);
  assert.equal(parsed.originalRows[1].country_code, 'uk');
  assert.equal(parsed.originalRows[3].company_name, ' Solaris Biotech ');
  assert.equal(parsed.originalRows[3].annual_value_usd, -19200);
  assert.equal(Object.isFrozen(parsed.originalRows), true);
  assert.equal(Object.isFrozen(parsed.originalRows[0]), true);
});

test('parseAndValidateUploadedFile parses valid .xlsx workbooks with accurate metadata and 10-row preview', async () => {
  const file = createSampleXlsxUploadFile();
  const parsed = await parseAndValidateUploadedFile(file);

  assert.equal(parsed.name, 'supply_orders_2026.xlsx');
  assert.equal(parsed.fileType, 'XLSX');
  assert.equal(parsed.fileSizeBytes, file.size);
  assert.equal(parsed.totalRows, 12);
  assert.equal(parsed.totalColumns, 6);
  assert.equal(parsed.previewRows.length, 10);
  assert.equal(parsed.originalRows[0].customer_name, 'Kestrel Precision ');
  assert.equal(parsed.originalRows[3].customer_name, null);
});

test('rejects empty CSV files (whitespace-only and header-only)', () => {
  assert.throws(
    () => parseCsvContent('   \n\r\n  ', 'blank.csv', 8),
    (err: unknown) =>
      err instanceof UploadValidationError && err.code === 'EMPTY_FILE'
  );

  assert.throws(
    () => parseCsvContent('id,name,email\n', 'headers_only.csv', 14),
    (err: unknown) =>
      err instanceof UploadValidationError && err.code === 'EMPTY_FILE'
  );
});

test('rejects empty Excel workbooks with no data rows', () => {
  const emptySheet = XLSX.utils.aoa_to_sheet([['id', 'name', 'email']]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, emptySheet, 'Sheet1');
  const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

  assert.throws(
    () => parseXlsxBuffer(bytes, 'headers_only.xlsx', bytes.byteLength),
    (err: unknown) =>
      err instanceof UploadValidationError && err.code === 'EMPTY_FILE'
  );
});

test('rejects corrupted CSV files (binary NUL bytes and unclosed quotes)', () => {
  assert.throws(
    () => parseCsvContent('col1,col2\nval1,\u0000binary', 'corrupt.csv', 24),
    (err: unknown) =>
      err instanceof UploadValidationError && err.code === 'CORRUPTED_FILE'
  );

  assert.throws(
    () => parseCsvContent('id,name\n1,"unclosed quote\n2,normal', 'broken_quotes.csv', 34),
    (err: unknown) =>
      err instanceof UploadValidationError && err.code === 'CORRUPTED_FILE'
  );
});

test('rejects corrupted Excel (.xlsx) files (non-ZIP garbage and truncated ZIP archives)', () => {
  const plainTextRenamed = new TextEncoder().encode('this is not a zip excel file');
  assert.throws(
    () => parseXlsxBuffer(plainTextRenamed, 'fake.xlsx', plainTextRenamed.byteLength),
    (err: unknown) =>
      err instanceof UploadValidationError && err.code === 'CORRUPTED_FILE'
  );

  // Starts with PK magic header but truncated/corrupt archive body
  const corruptZip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00, 0x11, 0x22]);
  assert.throws(
    () => parseXlsxBuffer(corruptZip, 'corrupt.xlsx', corruptZip.byteLength),
    (err: unknown) =>
      err instanceof UploadValidationError && err.code === 'CORRUPTED_FILE'
  );
});
