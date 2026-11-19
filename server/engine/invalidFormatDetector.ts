import { isCellMissing } from './missingValueDetector.ts';
import type {
  FlaggedCellOccurrence,
  InvalidFormatFinding,
  InvalidFormatReport,
  TabularRow,
} from './types.ts';

const REGIONAL_DATE_RE = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/;
const SLASH_YMD_DATE_RE = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CURRENCY_STRING_RE =
  /^(?:-?\s*(?:[A-Z]{3}\s*|\$|€|£|₹)\s*|(?:[A-Z]{3}\s*|\$|€|£|₹)\s*-?)[\d,]+(?:\.\d+)?$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_ALLOWED_RE = /^\+?[\d\s\-().]+$/;

const NUMERIC_COL_RE = /amount|cost|price|value|usd|revenue|salary|age|qty|quantity|total|arr/i;
const DATE_COL_RE = /date|timestamp|created|updated|renewal|dispatch|due|intake|dob|birth|joined|signup/i;
const EMAIL_COL_RE = /email|e_mail|e-mail|mail/i;
const PHONE_COL_RE = /phone|mobile|tel|contact_no|cell|whatsapp/i;

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false;
  }
  if (year < 1900 || year > 2150 || month < 1 || month > 12 || day < 1) {
    return false;
  }
  const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= maxDay;
}

export function parseCurrencyString(raw: string): number | null {
  const trimmed = raw.trim();
  if (!CURRENCY_STRING_RE.test(trimmed)) return null;
  const isNegative = trimmed.startsWith('-') || /^(?:[A-Z]{3}\s*|\$|€|£|₹)\s*-/i.test(trimmed);
  const cleaned = trimmed
    .replace(/^-?\s*(?:[A-Z]{3}\s*|\$|€|£|₹)\s*-?\s*/i, '')
    .replace(/,/g, '');
  const num = Number(cleaned);
  if (!Number.isFinite(num)) return null;
  return isNegative ? -Math.abs(num) : num;
}

export function normalizeRegionalDateString(raw: string): string | null {
  const trimmed = raw.trim();
  const isoMatch = trimmed.match(ISO_DATE_RE);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    return isValidCalendarDate(year, month, day) ? trimmed : null;
  }

  const slashYmd = trimmed.match(SLASH_YMD_DATE_RE);
  if (slashYmd) {
    const year = Number(slashYmd[1]);
    const month = Number(slashYmd[2]);
    const day = Number(slashYmd[3]);
    if (!isValidCalendarDate(year, month, day)) return null;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  const match = trimmed.match(REGIONAL_DATE_RE);
  if (!match) return null;
  const first = Number(match[1]);
  const second = Number(match[2]);
  const year = Number(match[3]);

  let day = first;
  let month = second;
  if (second > 12 && first <= 12) {
    month = first;
    day = second;
  }
  if (!isValidCalendarDate(year, month, day)) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function isValidIsoDate(raw: string): boolean {
  const match = raw.match(ISO_DATE_RE);
  if (!match) return false;
  return isValidCalendarDate(
    Number(match[1]),
    Number(match[2]),
    Number(match[3])
  );
}

function isValidPhoneNumber(raw: string): boolean {
  const trimmed = raw.trim();
  if (!PHONE_ALLOWED_RE.test(trimmed)) return false;
  const digits = trimmed.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

/**
 * Detects invalid data formats across email addresses, phone numbers, dates,
 * and numeric/currency schema fields, recording exact per-row occurrences.
 * Pure function — does not mutate input rows.
 */
export function detectInvalidFormats(
  columns: readonly string[],
  rows: ReadonlyArray<Readonly<TabularRow>>
): InvalidFormatReport {
  if (columns.length === 0 || rows.length === 0) {
    return { totalInvalidCells: 0, findings: [] };
  }

  const findings: InvalidFormatFinding[] = [];
  let totalInvalidCells = 0;

  for (const col of columns) {
    const isNumericCol = NUMERIC_COL_RE.test(col);
    const isDateCol = DATE_COL_RE.test(col);
    const isPhoneCol = PHONE_COL_RE.test(col);

    // Infer email column by header name or if >= 40% of non-null string cells contain '@'
    let isEmailCol = EMAIL_COL_RE.test(col);
    if (!isEmailCol && !isNumericCol && !isDateCol && !isPhoneCol) {
      let nonNullStrings = 0;
      let atSignCount = 0;
      for (const row of rows) {
        const v = row[col];
        if (!isCellMissing(v) && typeof v === 'string') {
          nonNullStrings += 1;
          if (v.includes('@')) atSignCount += 1;
        }
      }
      if (nonNullStrings >= 2 && atSignCount / nonNullStrings >= 0.4) {
        isEmailCol = true;
      }
    }

    const currencyCells: FlaggedCellOccurrence[] = [];
    const invalidNumericCells: FlaggedCellOccurrence[] = [];
    const regionalDateCells: FlaggedCellOccurrence[] = [];
    const invalidDateCells: FlaggedCellOccurrence[] = [];
    const invalidEmailCells: FlaggedCellOccurrence[] = [];
    const invalidPhoneCells: FlaggedCellOccurrence[] = [];

    for (let i = 0; i < rows.length; i += 1) {
      const val = rows[i][col];
      if (isCellMissing(val)) continue;

      if (typeof val === 'string') {
        const trimmed = val.trim();

        if (isNumericCol) {
          const parsedCurrency = parseCurrencyString(val);
          if (parsedCurrency !== null) {
            currencyCells.push({
              rowIndex: i,
              originalValue: val,
              suggestedValue: String(parsedCurrency),
            });
          } else {
            const parsedNum = Number(trimmed.replace(/,/g, ''));
            if (!Number.isFinite(parsedNum)) {
              invalidNumericCells.push({
                rowIndex: i,
                originalValue: val,
              });
            }
          }
          continue;
        }

        if (isDateCol) {
          if (isValidIsoDate(trimmed)) {
            continue;
          }
          const normalized = normalizeRegionalDateString(trimmed);
          if (normalized !== null) {
            regionalDateCells.push({
              rowIndex: i,
              originalValue: val,
              suggestedValue: normalized,
            });
          } else {
            invalidDateCells.push({
              rowIndex: i,
              originalValue: val,
            });
          }
          continue;
        }

        if (isEmailCol && !EMAIL_RE.test(trimmed)) {
          invalidEmailCells.push({
            rowIndex: i,
            originalValue: val,
          });
          continue;
        }

        if (isPhoneCol && !isValidPhoneNumber(trimmed)) {
          invalidPhoneCells.push({
            rowIndex: i,
            originalValue: val,
          });
        }
      } else if (typeof val === 'number') {
        if (isEmailCol) {
          invalidEmailCells.push({
            rowIndex: i,
            originalValue: String(val),
          });
        } else if (isPhoneCol && !isValidPhoneNumber(String(val))) {
          invalidPhoneCells.push({
            rowIndex: i,
            originalValue: String(val),
          });
        } else if (isDateCol) {
          invalidDateCells.push({
            rowIndex: i,
            originalValue: String(val),
          });
        }
      }
    }

    if (currencyCells.length > 0) {
      totalInvalidCells += currencyCells.length;
      findings.push({
        column: col,
        formatType: 'currency_string',
        category: 'Schema Mismatch',
        severity: 'Critical',
        affectedRows: currencyCells.length,
        rowIndices: currencyCells.map((c) => c.rowIndex),
        cells: currencyCells,
        sampleValue: currencyCells[0].originalValue,
        ruleTriggered: 'Strict numeric decimal schema',
      });
    }

    if (invalidNumericCells.length > 0) {
      totalInvalidCells += invalidNumericCells.length;
      findings.push({
        column: col,
        formatType: 'invalid_numeric',
        category: 'Schema Mismatch',
        severity: 'Critical',
        affectedRows: invalidNumericCells.length,
        rowIndices: invalidNumericCells.map((c) => c.rowIndex),
        cells: invalidNumericCells,
        sampleValue: invalidNumericCells[0].originalValue,
        ruleTriggered: 'Strict numeric type validation',
      });
    }

    if (regionalDateCells.length > 0) {
      totalInvalidCells += regionalDateCells.length;
      findings.push({
        column: col,
        formatType: 'non_iso_date',
        category: 'Format Drift',
        severity: 'Warning',
        affectedRows: regionalDateCells.length,
        rowIndices: regionalDateCells.map((c) => c.rowIndex),
        cells: regionalDateCells,
        sampleValue: regionalDateCells[0].originalValue,
        ruleTriggered: 'ISO-8601 date format (YYYY-MM-DD)',
      });
    }

    if (invalidDateCells.length > 0) {
      totalInvalidCells += invalidDateCells.length;
      findings.push({
        column: col,
        formatType: 'invalid_date',
        category: 'Schema Mismatch',
        severity: 'Critical',
        affectedRows: invalidDateCells.length,
        rowIndices: invalidDateCells.map((c) => c.rowIndex),
        cells: invalidDateCells,
        sampleValue: invalidDateCells[0].originalValue,
        ruleTriggered: 'Valid calendar date format',
      });
    }

    if (invalidEmailCells.length > 0) {
      totalInvalidCells += invalidEmailCells.length;
      findings.push({
        column: col,
        formatType: 'invalid_email',
        category: 'Format Drift',
        severity: 'Warning',
        affectedRows: invalidEmailCells.length,
        rowIndices: invalidEmailCells.map((c) => c.rowIndex),
        cells: invalidEmailCells,
        sampleValue: invalidEmailCells[0].originalValue,
        ruleTriggered: 'RFC-5322 email syntax check',
      });
    }

    if (invalidPhoneCells.length > 0) {
      totalInvalidCells += invalidPhoneCells.length;
      findings.push({
        column: col,
        formatType: 'invalid_phone',
        category: 'Format Drift',
        severity: 'Warning',
        affectedRows: invalidPhoneCells.length,
        rowIndices: invalidPhoneCells.map((c) => c.rowIndex),
        cells: invalidPhoneCells,
        sampleValue: invalidPhoneCells[0].originalValue,
        ruleTriggered: 'Standard telephone number format (7–15 digits)',
      });
    }
  }

  return { totalInvalidCells, findings };
}
