import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import {
  DatasetProcessingError,
  type ReadDatasetInput,
  type ReadDatasetResult,
  type TabularCell,
  type TabularRow,
} from './types.ts';

export const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB
export const DEFAULT_MAX_SAFE_ROWS = 50_000;

function getLowerExtension(filename: string): string {
  const trimmed = filename.trim();
  const dotIdx = trimmed.lastIndexOf('.');
  if (dotIdx <= 0 || dotIdx === trimmed.length - 1) return '';
  return trimmed.slice(dotIdx).toLowerCase();
}

function hasBinaryGarbage(text: string): boolean {
  if (text.includes('\u0000')) return true;
  const sampleLen = Math.min(text.length, 4000);
  if (sampleLen === 0) return false;
  let suspicious = 0;
  for (let i = 0; i < sampleLen; i += 1) {
    const code = text.charCodeAt(i);
    if (
      code === 0xfffd ||
      (code >= 1 && code <= 8) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31)
    ) {
      suspicious += 1;
    }
  }
  return suspicious / sampleLen > 0.02;
}

function hasZipSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

function formatExcelDateUtc(date: Date): string {
  // Add 30s tolerance for SheetJS serial-to-Date rounding near 23:59:59.999 UTC
  const adjusted = new Date(date.getTime() + 30_000);
  const y = adjusted.getUTCFullYear();
  const m = String(adjusted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(adjusted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function normalizeUploadedCell(val: unknown): TabularCell {
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

function freezeOriginalSnapshot(rows: TabularRow[]): ReadonlyArray<Readonly<TabularRow>> {
  return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
}

/**
 * Reusable server-side dataset reader supporting CSV (PapaParse) and Excel .xlsx (SheetJS).
 * Safely enforces file size & row limits, validates format integrity, and preserves an
 * immutable snapshot of the original uploaded rows.
 */
export function readDataset(input: ReadDatasetInput): ReadDatasetResult {
  const filename = (input.filename ?? '').trim();
  if (!filename) {
    throw new DatasetProcessingError(
      'INVALID_INPUT',
      'A valid filename is required to read a dataset.',
      400
    );
  }

  const ext = getLowerExtension(filename);
  if (ext !== '.csv' && ext !== '.xlsx') {
    throw new DatasetProcessingError(
      'UNSUPPORTED_FORMAT',
      `Unsupported file format (${ext || 'unknown'}). Only CSV (.csv) and Excel (.xlsx) files are supported.`,
      400
    );
  }

  const bytes =
    input.buffer instanceof Uint8Array
      ? input.buffer
      : Buffer.from(input.buffer ?? []);

  if (bytes.byteLength === 0) {
    throw new DatasetProcessingError(
      'EMPTY_FILE',
      `The uploaded file "${filename}" is empty (0 B).`,
      400
    );
  }

  const maxBytes = input.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
  if (bytes.byteLength > maxBytes) {
    const limitMb = Math.round((maxBytes / (1024 * 1024)) * 10) / 10;
    throw new DatasetProcessingError(
      'FILE_TOO_LARGE',
      `The uploaded file "${filename}" exceeds the ${limitMb} MB server processing limit.`,
      413
    );
  }

  const maxRows = Math.max(1, input.maxRows ?? DEFAULT_MAX_SAFE_ROWS);

  if (ext === '.csv') {
    if (bytes.includes(0)) {
      throw new DatasetProcessingError(
        'CORRUPTED_FILE',
        `The CSV file "${filename}" appears to be corrupted or contains binary data.`,
        400
      );
    }

    const decoded = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      .toString('utf8')
      .replace(/^\uFEFF/, '');

    if (hasBinaryGarbage(decoded)) {
      throw new DatasetProcessingError(
        'CORRUPTED_FILE',
        `The CSV file "${filename}" appears to be corrupted or unreadable.`,
        400
      );
    }

    if (decoded.trim().length === 0) {
      throw new DatasetProcessingError(
        'EMPTY_FILE',
        `The CSV file "${filename}" contains no readable data.`,
        400
      );
    }

    const seenCsvHeaders = new Map<string, number>();
    const parsed = Papa.parse<Record<string, string>>(decoded, {
      header: true,
      skipEmptyLines: 'greedy',
      dynamicTyping: false,
      transformHeader: (rawHeader) => {
        const cleaned = rawHeader.trim();
        if (!cleaned) return '';
        const seen = seenCsvHeaders.get(cleaned) ?? 0;
        seenCsvHeaders.set(cleaned, seen + 1);
        return seen === 0 ? cleaned : `${cleaned}_${seen + 1}`;
      },
    });

    const quoteErr = parsed.errors.find(
      (err) =>
        err.type === 'Quotes' ||
        err.code === 'MissingQuotes' ||
        err.code === 'InvalidQuotes'
    );
    if (quoteErr) {
      const rowHint =
        typeof quoteErr.row === 'number' ? ` near row ${quoteErr.row + 2}` : '';
      throw new DatasetProcessingError(
        'CORRUPTED_FILE',
        `The CSV file "${filename}" is malformed or corrupted${rowHint} (${quoteErr.message}).`,
        400
      );
    }

    const columns = (parsed.meta.fields ?? [])
      .map((field) => field.trim())
      .filter((field) => field.length > 0);

    if (columns.length === 0) {
      throw new DatasetProcessingError(
        'CORRUPTED_FILE',
        `The CSV file "${filename}" does not contain valid column headers.`,
        400
      );
    }

    const sourceRowCount = parsed.data.length;
    if (sourceRowCount === 0) {
      throw new DatasetProcessingError(
        'EMPTY_FILE',
        `The CSV file "${filename}" contains headers but no data rows.`,
        400
      );
    }

    const truncated = sourceRowCount > maxRows;
    const boundedData = truncated ? parsed.data.slice(0, maxRows) : parsed.data;

    const rows: TabularRow[] = boundedData.map((rawRow) => {
      const normalized: TabularRow = {};
      for (const col of columns) {
        normalized[col] = normalizeUploadedCell(rawRow[col]);
      }
      return normalized;
    });

    const hasValue = rows.some((row) =>
      columns.some((col) => row[col] !== null && String(row[col]).trim() !== '')
    );
    if (!hasValue) {
      throw new DatasetProcessingError(
        'EMPTY_FILE',
        `The CSV file "${filename}" contains only blank cells.`,
        400
      );
    }

    return {
      filename,
      fileType: 'CSV',
      fileSizeBytes: bytes.byteLength,
      columns,
      rows: rows.map((r) => ({ ...r })),
      originalRows: freezeOriginalSnapshot(rows),
      totalRows: rows.length,
      totalColumns: columns.length,
      truncated,
      sourceRowCount,
    };
  }

  // Excel (.xlsx) processing via SheetJS
  if (!hasZipSignature(bytes)) {
    throw new DatasetProcessingError(
      'CORRUPTED_FILE',
      `The Excel file "${filename}" is corrupted or not a valid .xlsx workbook.`,
      400
    );
  }

  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
      type: 'buffer',
      cellDates: true,
    });
  } catch {
    throw new DatasetProcessingError(
      'CORRUPTED_FILE',
      `The Excel file "${filename}" appears to be corrupted or unreadable.`,
      400
    );
  }

  const firstSheet = workbook.SheetNames[0];
  if (!firstSheet) {
    throw new DatasetProcessingError(
      'EMPTY_FILE',
      `The Excel workbook "${filename}" contains no worksheets.`,
      400
    );
  }

  const sheet = workbook.Sheets[firstSheet];
  if (!sheet || !sheet['!ref']) {
    throw new DatasetProcessingError(
      'EMPTY_FILE',
      `The first worksheet in "${filename}" is empty.`,
      400
    );
  }

  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: null,
    blankrows: false,
  });

  if (matrix.length === 0) {
    throw new DatasetProcessingError(
      'EMPTY_FILE',
      `The Excel workbook "${filename}" contains no readable rows.`,
      400
    );
  }

  const headerRow = matrix[0] ?? [];
  const columnDefs: { idx: number; name: string }[] = [];
  const seenHeaderCounts = new Map<string, number>();

  headerRow.forEach((cell, idx) => {
    const label = cell === null || cell === undefined ? '' : String(cell).trim();
    if (label.length > 0) {
      const seen = seenHeaderCounts.get(label) ?? 0;
      seenHeaderCounts.set(label, seen + 1);
      columnDefs.push({
        idx,
        name: seen === 0 ? label : `${label}_${seen + 1}`,
      });
    }
  });

  if (columnDefs.length === 0) {
    throw new DatasetProcessingError(
      'CORRUPTED_FILE',
      `The Excel workbook "${filename}" does not contain valid headers in row 1.`,
      400
    );
  }

  const dataRowsMatrix = matrix.slice(1);
  const sourceRowCount = dataRowsMatrix.length;
  if (sourceRowCount === 0) {
    throw new DatasetProcessingError(
      'EMPTY_FILE',
      `The Excel workbook "${filename}" contains headers but no data rows.`,
      400
    );
  }

  const truncated = sourceRowCount > maxRows;
  const boundedMatrix = truncated ? dataRowsMatrix.slice(0, maxRows) : dataRowsMatrix;
  const columns = columnDefs.map((col) => col.name);

  const rows: TabularRow[] = boundedMatrix.map((rawRow) => {
    const normalized: TabularRow = {};
    for (const col of columnDefs) {
      const cell = Array.isArray(rawRow) ? rawRow[col.idx] : null;
      normalized[col.name] = normalizeUploadedCell(cell);
    }
    return normalized;
  });

  const hasValue = rows.some((row) =>
    columns.some((col) => row[col] !== null && String(row[col]).trim() !== '')
  );
  if (!hasValue) {
    throw new DatasetProcessingError(
      'EMPTY_FILE',
      `The Excel workbook "${filename}" contains only blank data cells.`,
      400
    );
  }

  return {
    filename,
    fileType: 'XLSX',
    fileSizeBytes: bytes.byteLength,
    columns,
    rows: rows.map((r) => ({ ...r })),
    originalRows: freezeOriginalSnapshot(rows),
    totalRows: rows.length,
    totalColumns: columns.length,
    truncated,
    sourceRowCount,
  };
}
