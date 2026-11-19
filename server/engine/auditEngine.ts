import type {
  AuditModificationRecord,
  AuditModificationValidationStatus,
  ModificationHistoryEntry,
  ValidationComparisonReport,
  ValidationRepairOutcome,
} from '../../src/types/datafix.ts';

export interface AuditModificationFilters {
  datasetId?: string;
  columnName?: string;
  repairMethod?: string;
  validationStatus?: 'All' | AuditModificationValidationStatus;
  searchQuery?: string;
}

/**
 * Generates authoritative AuditModificationRecord entries directly from actual
 * approved repair operations, attaching the Validation Engine's confirmation status
 * for every cell modification and duplicate row removal.
 * Pure function — never invents synthetic entries.
 */
export function recordApprovedModifications(params: {
  historyEntries: readonly ModificationHistoryEntry[];
  validationReport?: ValidationComparisonReport | null;
}): AuditModificationRecord[] {
  const { historyEntries, validationReport } = params;
  const outcomeByHistoryId = new Map<string, ValidationRepairOutcome>();

  if (validationReport?.repairOutcomes) {
    for (const outcome of validationReport.repairOutcomes) {
      outcomeByHistoryId.set(outcome.historyEntryId, outcome);
    }
  }

  const records: AuditModificationRecord[] = [];
  for (let idx = 0; idx < historyEntries.length; idx += 1) {
    const entry = historyEntries[idx];
    if (
      entry.action === 'Restored Original' ||
      entry.issueType === 'Dataset Restore'
    ) {
      continue;
    }

    const matchedOutcome = outcomeByHistoryId.get(entry.id);
    const validationStatus: AuditModificationValidationStatus = matchedOutcome
      ? matchedOutcome.status
      : 'Pending Validation';

    records.push({
      id: `audmod-${entry.id}`,
      historyEntryId: entry.id,
      datasetId: entry.datasetId,
      datasetName: entry.datasetName,
      rowNumber: entry.rowNumber,
      columnName: entry.column,
      originalValue: entry.originalValue,
      updatedValue: entry.newValue,
      reason: entry.reason,
      repairMethod: entry.repairMethod,
      timestamp: entry.timestamp,
      validationStatus,
      verificationNote: matchedOutcome?.verificationNote,
      issueType: entry.issueType,
      action: entry.action,
      actor: entry.actor,
    });
  }

  return records;
}

/**
 * Synchronizes validation status on existing active audit modification records
 * after the Validation Engine re-analyzes a dataset.
 * Reverted historical records remain unchanged.
 */
export function syncAuditValidationStatuses(
  existingRecords: readonly AuditModificationRecord[],
  validationReport: ValidationComparisonReport
): AuditModificationRecord[] {
  const outcomeByHistoryId = new Map<string, ValidationRepairOutcome>();
  for (const outcome of validationReport.repairOutcomes) {
    outcomeByHistoryId.set(outcome.historyEntryId, outcome);
  }

  return existingRecords.map((record) => {
    if (
      record.datasetId !== validationReport.datasetId ||
      record.validationStatus === 'Reverted'
    ) {
      return record;
    }

    const matched = outcomeByHistoryId.get(record.historyEntryId);
    if (!matched) {
      return record;
    }

    return {
      ...record,
      validationStatus: matched.status,
      verificationNote: matched.verificationNote,
    };
  });
}

/**
 * Marks previously active audit modification records for a dataset as 'Reverted'
 * when the user restores the original dataset, preserving the full immutable audit trail.
 */
export function markDatasetAuditModificationsReverted(
  existingRecords: readonly AuditModificationRecord[],
  datasetId: string
): AuditModificationRecord[] {
  return existingRecords.map((record) => {
    if (
      record.datasetId !== datasetId ||
      record.validationStatus === 'Reverted'
    ) {
      return record;
    }
    return {
      ...record,
      validationStatus: 'Reverted',
      verificationNote:
        'Working dataset was restored to the preserved original upload after this modification.',
    };
  });
}

/**
 * Filters recorded audit modifications by dataset, column, repair method,
 * validation status, and free-text query across all key fields.
 */
export function filterAuditModifications(
  records: readonly AuditModificationRecord[],
  filters: AuditModificationFilters
): AuditModificationRecord[] {
  const q = (filters.searchQuery ?? '').trim().toLowerCase();

  return records.filter((rec) => {
    if (
      filters.datasetId &&
      filters.datasetId !== 'ALL' &&
      rec.datasetId !== filters.datasetId
    ) {
      return false;
    }
    if (
      filters.columnName &&
      filters.columnName !== 'ALL' &&
      rec.columnName !== filters.columnName
    ) {
      return false;
    }
    if (
      filters.repairMethod &&
      filters.repairMethod !== 'ALL' &&
      rec.repairMethod !== filters.repairMethod
    ) {
      return false;
    }
    if (
      filters.validationStatus &&
      filters.validationStatus !== 'All' &&
      rec.validationStatus !== filters.validationStatus
    ) {
      return false;
    }
    if (q.length > 0) {
      const haystack = [
        `row ${rec.rowNumber}`,
        String(rec.rowNumber),
        rec.datasetName,
        rec.columnName,
        rec.originalValue,
        rec.updatedValue,
        rec.reason,
        rec.repairMethod,
        rec.timestamp,
        rec.validationStatus,
        rec.issueType,
      ]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(q)) {
        return false;
      }
    }
    return true;
  });
}

function escapeCsvCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/**
 * Serializes audit modification records into an RFC-4180 CSV audit report
 * containing all 8 required audit fields plus dataset context and verification details.
 */
export function serializeAuditReportCsv(
  records: readonly AuditModificationRecord[]
): string {
  const headers = [
    'Row Number',
    'Column Name',
    'Original Value',
    'Updated Value',
    'Reason for Modification',
    'Repair Method',
    'Timestamp',
    'Validation Status',
    'Dataset Name',
    'Issue Type',
    'Actor',
    'Verification Note',
  ];

  const lines: string[] = [headers.join(',')];
  for (const rec of records) {
    lines.push(
      [
        rec.rowNumber,
        rec.columnName,
        rec.originalValue,
        rec.updatedValue,
        rec.reason,
        rec.repairMethod,
        rec.timestamp,
        rec.validationStatus,
        rec.datasetName,
        rec.issueType,
        rec.actor,
        rec.verificationNote ?? '',
      ]
        .map(escapeCsvCell)
        .join(',')
    );
  }
  return lines.join('\n');
}

/**
 * Builds a structured JSON audit report object with summary counts and full records.
 */
export function buildAuditReportJson(
  records: readonly AuditModificationRecord[],
  generatedAt = new Date().toISOString()
) {
  let confirmedCount = 0;
  let failedCount = 0;
  let pendingCount = 0;
  let revertedCount = 0;

  for (const rec of records) {
    if (rec.validationStatus === 'Confirmed') confirmedCount += 1;
    else if (rec.validationStatus === 'Failed') failedCount += 1;
    else if (rec.validationStatus === 'Reverted') revertedCount += 1;
    else pendingCount += 1;
  }

  return {
    reportTitle: 'DataFix Approved Modification Audit Report',
    generatedAt,
    summary: {
      totalModifications: records.length,
      confirmedCount,
      failedCount,
      pendingCount,
      revertedCount,
    },
    modifications: records.map((rec) => ({
      rowNumber: rec.rowNumber,
      columnName: rec.columnName,
      originalValue: rec.originalValue,
      updatedValue: rec.updatedValue,
      reasonForModification: rec.reason,
      repairMethod: rec.repairMethod,
      timestamp: rec.timestamp,
      validationStatus: rec.validationStatus,
      datasetName: rec.datasetName,
      issueType: rec.issueType,
      actor: rec.actor,
      verificationNote: rec.verificationNote ?? null,
    })),
  };
}
