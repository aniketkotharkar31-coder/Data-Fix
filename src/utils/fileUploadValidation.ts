import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import type { DataRow } from '../types/datafix';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB
export const PREVIEW_ROW_LIMIT = 10;

export type UploadErrorCode =
  | 'UNSUPPORTED_TYPE'
  | 'EMPTY_FILE'
  | 'FILE_TOO_LARGE'
  | 'CORRUPTED_FILE';

export class UploadValidationError extends Error {
  readonly code: UploadErrorCode;

  constructor(code: UploadErrorCode, message: string) {
    super(message);
    this.name = 'UploadValidationError';
    this.code = code;
  }
}

export interface UploadedDatasetDraft {
  name: string;
  fileType: 'CSV' | 'XLSX';
  fileSizeBytes: number;
  totalRows: number;
  totalColumns: number;
  columns: string[];
  /** Frozen, unmodified snapshot of all uploaded rows */
  originalRows: ReadonlyArray<Readonly<DataRow>>;
  /** First 10 rows sliced from originalRows without mutating source data */
  previewRows: ReadonlyArray<Readonly<DataRow>>;
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 100 ? 0 : 1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb >= 100 ? 0 : 2)} MB`;
}

export function getFileExtension(filename: string): string {
  const trimmed = filename.trim();
  const lastDot = trimmed.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === trimmed.length - 1) {
    return '';
  }
  return trimmed.slice(lastDot).toLowerCase();
}

export function validateUploadFileMeta(file: {
  name: string;
  size: number;
}): { fileType: 'CSV' | 'XLSX' } {
  const ext = getFileExtension(file.name);
  if (ext !== '.csv' && ext !== '.xlsx') {
    const label = ext || 'unknown';
    throw new UploadValidationError(
      'UNSUPPORTED_TYPE',
      `Unsupported file type (${label}). Only CSV (.csv) and Excel (.xlsx) files are supported.`
    );
  }

  if (file.size === 0) {
    throw new UploadValidationError(
      'EMPTY_FILE',
      `The file "${file.name}" is empty (0 B). Please upload a file containing headers and data rows.`
    );
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    throw new UploadValidationError(
      'FILE_TOO_LARGE',
      `The file "${file.name}" (${formatFileSize(file.size)}) exceeds the 25 MB upload limit.`
    );
  }

  return { fileType: ext === '.xlsx' ? 'XLSX' : 'CSV' };
}

export function hasBinaryGarbage(text: string): boolean {
  if (text.includes('\u0000')) {
    return true;
  }
  const sampleLen = Math.min(text.length, 4000);
  if (sampleLen === 0) return false;

  let suspiciousCount = 0;
  for (let i = 0; i < sampleLen; i++) {
    const code = text.charCodeAt(i);
    const isReplacement = code === 0xfffd;
    const isControl =
      (code >= 1 && code <= 8) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31);
    if (isReplacement || isControl) {
      suspiciousCount += 1;
    }
  }
  return suspiciousCount / sampleLen > 0.02;
}

export function hasZipMagicHeader(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

export function slicePreviewRows(
  rows: ReadonlyArray<Readonly<DataRow>>,
  limit = PREVIEW_ROW_LIMIT
): ReadonlyArray<Readonly<DataRow>> {
  return rows.slice(0, Math.max(0, limit));
}

function freezeRowsSnapshot(rows: DataRow[]): ReadonlyArray<Readonly<DataRow>> {
  return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
}

function formatExcelDateUtc(date: Date): string {
  const adjusted = new Date(date.getTime() + 30_000);
  const y = adjusted.getUTCFullYear();
  const m = String(adjusted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(adjusted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function normalizeCellValue(val: unknown): string | number | null {
  if (val === undefined || val === null) return null;
  if (val instanceof Date) {
    return Number.isNaN(val.getTime()) ? null : formatExcelDateUtc(val);
  }
  if (typeof val === 'number') {
    return Number.isFinite(val) ? val : null;
  }
  if (typeof val === 'boolean') {
    return val ? 'true' : 'false';
  }
  const str = String(val);
  if (str === '') return null;
  const trimmed = str.trim();
  const isPureNumber =
    trimmed !== '' &&
    str === trimmed &&
    /^-?\d+(?:\.\d+)?$/.test(trimmed) &&
    !(trimmed.length > 1 && trimmed.startsWith('0') && !trimmed.startsWith('0.'));
  return isPureNumber ? Number(trimmed) : str;
}

export function parseCsvContent(
  text: string,
  filename: string,
  fileSizeBytes: number
): UploadedDatasetDraft {
  if (hasBinaryGarbage(text)) {
    throw new UploadValidationError(
      'CORRUPTED_FILE',
      `The CSV file "${filename}" appears to be corrupted or contains invalid binary data.`
    );
  }

  const stripped = text.replace(/^\uFEFF/, '');
  if (stripped.trim().length === 0) {
    throw new UploadValidationError(
      'EMPTY_FILE',
      `The CSV file "${filename}" contains no readable data. Please upload a non-empty file.`
    );
  }

  const seenCsvHeaders = new Map<string, number>();
  const parsed = Papa.parse<Record<string, string>>(stripped, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (rawHeader) => {
      const cleaned = rawHeader.trim();
      if (!cleaned) return '';
      const seen = seenCsvHeaders.get(cleaned) ?? 0;
      seenCsvHeaders.set(cleaned, seen + 1);
      return seen === 0 ? cleaned : `${cleaned}_${seen + 1}`;
    },
  });

  const fatalQuoteError = parsed.errors.find(
    (err) => err.type === 'Quotes' || err.code === 'MissingQuotes' || err.code === 'InvalidQuotes'
  );
  if (fatalQuoteError) {
    const rowDetail =
      typeof fatalQuoteError.row === 'number'
        ? ` near row ${fatalQuoteError.row + 2}`
        : '';
    throw new UploadValidationError(
      'CORRUPTED_FILE',
      `The CSV file "${filename}" appears to be malformed or corrupted${rowDetail} (${fatalQuoteError.message}).`
    );
  }

  const rawFields = parsed.meta.fields ?? [];
  const columns = rawFields.map((col) => col.trim()).filter((col) => col.length > 0);

  if (columns.length === 0) {
    throw new UploadValidationError(
      'CORRUPTED_FILE',
      `The CSV file "${filename}" does not contain valid column headers.`
    );
  }

  if (parsed.data.length === 0) {
    throw new UploadValidationError(
      'EMPTY_FILE',
      `The CSV file "${filename}" contains column headers but no data rows to analyze.`
    );
  }

  const rows: DataRow[] = parsed.data.map((rawRow) => {
    const normalized: DataRow = {};
    for (const col of columns) {
      normalized[col] = normalizeCellValue(rawRow[col]);
    }
    return normalized;
  });

  const hasAnyCellValue = rows.some((row) =>
    columns.some((col) => row[col] !== null && String(row[col]).trim() !== '')
  );
  if (!hasAnyCellValue) {
    throw new UploadValidationError(
      'EMPTY_FILE',
      `The CSV file "${filename}" contains only blank rows with no data values.`
    );
  }

  const originalRows = freezeRowsSnapshot(rows);

  return {
    name: filename,
    fileType: 'CSV',
    fileSizeBytes,
    totalRows: originalRows.length,
    totalColumns: columns.length,
    columns,
    originalRows,
    previewRows: slicePreviewRows(originalRows, PREVIEW_ROW_LIMIT),
  };
}

export function parseXlsxBuffer(
  buffer: ArrayBuffer | Uint8Array,
  filename: string,
  fileSizeBytes: number
): UploadedDatasetDraft {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length === 0) {
    throw new UploadValidationError(
      'EMPTY_FILE',
      `The Excel file "${filename}" is empty (0 B).`
    );
  }

  if (!hasZipMagicHeader(bytes)) {
    throw new UploadValidationError(
      'CORRUPTED_FILE',
      `The Excel file "${filename}" is corrupted or not a valid .xlsx workbook.`
    );
  }

  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(bytes, { type: 'array', cellDates: true });
  } catch {
    throw new UploadValidationError(
      'CORRUPTED_FILE',
      `The Excel file "${filename}" appears to be corrupted or unreadable. Please re-export a valid .xlsx workbook.`
    );
  }

  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    throw new UploadValidationError(
      'EMPTY_FILE',
      `The Excel workbook "${filename}" contains no readable worksheets.`
    );
  }

  const sheet = workbook.Sheets[firstSheetName];
  if (!sheet || !sheet['!ref']) {
    throw new UploadValidationError(
      'EMPTY_FILE',
      `The first worksheet in "${filename}" is empty and contains no headers or rows.`
    );
  }

  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: null,
    blankrows: false,
  });

  if (matrix.length === 0) {
    throw new UploadValidationError(
      'EMPTY_FILE',
      `The first worksheet in "${filename}" contains no readable rows.`
    );
  }

  const headerRow = matrix[0] ?? [];
  const columnIndices: { index: number; name: string }[] = [];
  const seenNames = new Map<string, number>();

  headerRow.forEach((cell, idx) => {
    const label = cell === null || cell === undefined ? '' : String(cell).trim();
    if (label.length > 0) {
      const count = seenNames.get(label) ?? 0;
      seenNames.set(label, count + 1);
      const uniqueName = count === 0 ? label : `${label}_${count + 1}`;
      columnIndices.push({ index: idx, name: uniqueName });
    }
  });

  if (columnIndices.length === 0) {
    throw new UploadValidationError(
      'CORRUPTED_FILE',
      `The Excel workbook "${filename}" does not contain valid column headers in row 1.`
    );
  }

  const dataMatrix = matrix.slice(1);
  if (dataMatrix.length === 0) {
    throw new UploadValidationError(
      'EMPTY_FILE',
      `The Excel workbook "${filename}" contains column headers but no data rows to analyze.`
    );
  }

  const columns = columnIndices.map((item) => item.name);
  const rows: DataRow[] = dataMatrix.map((rawRow) => {
    const normalized: DataRow = {};
    for (const col of columnIndices) {
      const cell = Array.isArray(rawRow) ? rawRow[col.index] : null;
      normalized[col.name] = normalizeCellValue(cell);
    }
    return normalized;
  });

  const hasAnyCellValue = rows.some((row) =>
    columns.some((col) => row[col] !== null && String(row[col]).trim() !== '')
  );
  if (!hasAnyCellValue) {
    throw new UploadValidationError(
      'EMPTY_FILE',
      `The Excel workbook "${filename}" contains only blank data cells.`
    );
  }

  const originalRows = freezeRowsSnapshot(rows);

  return {
    name: filename,
    fileType: 'XLSX',
    fileSizeBytes,
    totalRows: originalRows.length,
    totalColumns: columns.length,
    columns,
    originalRows,
    previewRows: slicePreviewRows(originalRows, PREVIEW_ROW_LIMIT),
  };
}

export async function parseAndValidateUploadedFile(
  file: File
): Promise<UploadedDatasetDraft> {
  const { fileType } = validateUploadFileMeta({ name: file.name, size: file.size });

  if (fileType === 'CSV') {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    if (bytes.includes(0)) {
      throw new UploadValidationError(
        'CORRUPTED_FILE',
        `The CSV file "${file.name}" appears to be corrupted or contains invalid binary data.`
      );
    }
    const text = new TextDecoder('utf-8').decode(bytes);
    return parseCsvContent(text, file.name, file.size);
  }

  const buffer = await file.arrayBuffer();
  return parseXlsxBuffer(buffer, file.name, file.size);
}

export function createSampleCsvUploadFile(): File {
  const csv = [
    'customer_id,company_name,contact_email,country_code,annual_value_usd,renewal_date',
    'CUS-3001,Meridian Freight,billing@meridian.io,US,128400,2027-01-15',
    'CUS-3002,Harborline Systems,,uk,84200,15/03/2027',
    'CUS-3002,Harborline Systems,ops@harborline.co.uk,GB,84200,2027-03-15',
    'CUS-3003, Solaris Biotech ,finance@solarisbio.com,de,-19200,22/05/2027',
    'CUS-3004,Atlas Maritime,ap@atlasmaritime.sg,SG,67500,2027-06-30',
    'CUS-3005,Northstar Logistics,accounts@northstar.ca,CA,112000,2027-07-12',
    'CUS-3006,Veridian Health,,us,95400,08/09/2027',
    'CUS-3007,Cobalt Manufacturing,ar@cobaltmfg.com,US,154800,2027-08-21',
    'CUS-3008,Redwood Photonics,billing@redwood.io,GB,73900,2027-09-14',
    'CUS-3009,Helios Grid Corp,finance@heliosgrid.eu,DE,204500,19/10/2027',
    'CUS-3010,Pacific Coldchain,ops@pacificcold.au,AU,88100,2027-11-03',
    'CUS-3011,Summit Robotics,ap@summitrobotics.jp,JP,142000,2027-12-01',
  ].join('\n');

  return new File([csv], 'customer_accounts_q4.csv', { type: 'text/csv' });
}

export function createSampleXlsxUploadFile(): File {
  const sampleRows: DataRow[] = [
    {
      order_id: 'ORD-6101',
      customer_name: 'Kestrel Precision ',
      currency: 'usd ',
      unit_cost: 'USD 84.50',
      order_date: '18/11/2026',
      total_amount: 1690,
    },
    {
      order_id: 'ORD-6102',
      customer_name: 'Nordic Bearings',
      currency: 'eur',
      unit_cost: 42.0,
      order_date: '2026-11-19',
      total_amount: -420,
    },
    {
      order_id: 'ORD-6102',
      customer_name: 'Nordic Bearings',
      currency: 'EUR',
      unit_cost: 42.0,
      order_date: '2026-11-19',
      total_amount: 420,
    },
    {
      order_id: 'ORD-6103',
      customer_name: null,
      currency: 'USD',
      unit_cost: '$112.00',
      order_date: '2026-11-20',
      total_amount: 2240,
    },
    {
      order_id: 'ORD-6104',
      customer_name: 'Vanguard Sensors',
      currency: 'USD',
      unit_cost: 65.25,
      order_date: '2026-11-21',
      total_amount: 1305,
    },
    {
      order_id: 'ORD-6105',
      customer_name: 'Alpine Photonics',
      currency: 'CHF',
      unit_cost: 91.0,
      order_date: '22/11/2026',
      total_amount: 1820,
    },
    {
      order_id: 'ORD-6106',
      customer_name: 'Boreal Robotics',
      currency: 'EUR',
      unit_cost: 120.5,
      order_date: '2026-11-23',
      total_amount: 2410,
    },
    {
      order_id: 'ORD-6107',
      customer_name: 'Solstice Energy',
      currency: 'USD',
      unit_cost: 77.0,
      order_date: '2026-11-24',
      total_amount: 1540,
    },
    {
      order_id: 'ORD-6108',
      customer_name: 'Crestline Medical',
      currency: 'GBP',
      unit_cost: 54.75,
      order_date: '25/11/2026',
      total_amount: 1095,
    },
    {
      order_id: 'ORD-6109',
      customer_name: 'Ironworks Logistics',
      currency: 'USD',
      unit_cost: 38.4,
      order_date: '2026-11-26',
      total_amount: 768,
    },
    {
      order_id: 'ORD-6110',
      customer_name: 'Tidewater Systems',
      currency: 'USD',
      unit_cost: 99.0,
      order_date: '2026-11-27',
      total_amount: 1980,
    },
    {
      order_id: 'ORD-6111',
      customer_name: 'Clearwater Labs',
      currency: 'CAD',
      unit_cost: 61.2,
      order_date: '2026-11-28',
      total_amount: 1224,
    },
  ];
  const sheet = XLSX.utils.json_to_sheet(sampleRows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, 'Orders');
  const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return new File([bytes], 'supply_orders_2026.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}
