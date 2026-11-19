import type {
  DetectedIssueRecord,
  IssueCategory,
  IssueSeverity,
  QualityIssue,
} from '../../src/types/datafix.ts';

export type TabularCell = string | number | null;
export type TabularRow = Record<string, TabularCell>;

export type DatasetErrorCode =
  | 'UNSUPPORTED_FORMAT'
  | 'EMPTY_FILE'
  | 'FILE_TOO_LARGE'
  | 'CORRUPTED_FILE'
  | 'INVALID_INPUT';

export class DatasetProcessingError extends Error {
  readonly code: DatasetErrorCode;
  readonly statusCode: number;

  constructor(code: DatasetErrorCode, message: string, statusCode = 400) {
    super(message);
    this.name = 'DatasetProcessingError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface ReadDatasetInput {
  buffer: Buffer | Uint8Array;
  filename: string;
  mimeType?: string;
  maxBytes?: number;
  maxRows?: number;
}

export interface ReadDatasetResult {
  filename: string;
  fileType: 'CSV' | 'XLSX';
  fileSizeBytes: number;
  columns: string[];
  rows: TabularRow[];
  /** Frozen immutable snapshot of the original uploaded dataset */
  originalRows: ReadonlyArray<Readonly<TabularRow>>;
  totalRows: number;
  totalColumns: number;
  truncated: boolean;
  sourceRowCount: number;
}

export interface FlaggedCellOccurrence {
  /** 0-based index into rows array (display rowNumber = rowIndex + 1) */
  rowIndex: number;
  originalValue: string;
  suggestedValue?: string;
  detail?: string;
}

export interface MissingValueColumnReport {
  column: string;
  missingCount: number;
  missingPercent: number;
  rowIndices: number[];
  cells: FlaggedCellOccurrence[];
  severity: IssueSeverity;
  sampleValue: string;
  ruleTriggered: string;
}

export interface MissingValueReport {
  totalMissingCells: number;
  affectedRowCount: number;
  missingRatePercent: number;
  byColumn: MissingValueColumnReport[];
}

export interface DuplicateKeyGroup {
  column: string;
  keyValue: string;
  rowIndices: number[];
  occurrences: number;
}

export interface ExactDuplicateMatch {
  rowIndex: number;
  firstRowIndex: number;
  originalValue: string;
}

export interface DuplicateReport {
  totalDuplicateRows: number;
  exactDuplicateCount: number;
  exactDuplicateRowIndices: number[];
  exactDuplicateMatches: ExactDuplicateMatch[];
  keyColumn: string | null;
  keyDuplicateCount: number;
  keyDuplicateRowIndices: number[];
  duplicateKeys: DuplicateKeyGroup[];
}

export interface InvalidFormatFinding {
  column: string;
  formatType:
    | 'currency_string'
    | 'non_iso_date'
    | 'invalid_date'
    | 'invalid_email'
    | 'invalid_numeric'
    | 'invalid_phone';
  category: IssueCategory;
  severity: IssueSeverity;
  affectedRows: number;
  rowIndices: number[];
  cells: FlaggedCellOccurrence[];
  sampleValue: string;
  ruleTriggered: string;
}

export interface InvalidFormatReport {
  totalInvalidCells: number;
  findings: InvalidFormatFinding[];
}

export interface InconsistentValueFinding {
  column: string;
  issueType:
    | 'whitespace_drift'
    | 'code_standardization'
    | 'case_inconsistency'
    | 'categorical_synonym'
    | 'fuzzy_spelling';
  severity: IssueSeverity;
  affectedRows: number;
  rowIndices: number[];
  cells: FlaggedCellOccurrence[];
  sampleValue: string;
  canonicalValue?: string;
  variants: string[];
  ruleTriggered: string;
}

export interface InconsistentValueReport {
  totalInconsistentCells: number;
  findings: InconsistentValueFinding[];
}

export interface AnomalyFinding {
  column: string;
  anomalyType: 'negative_boundary' | 'statistical_outlier' | 'domain_range';
  severity: IssueSeverity;
  affectedRows: number;
  rowIndices: number[];
  cells: FlaggedCellOccurrence[];
  sampleValue: string;
  bounds?: { min: number; max: number; q1?: number; q3?: number; iqr?: number };
  ruleTriggered: string;
}

export interface AnomalyReport {
  totalAnomalies: number;
  findings: AnomalyFinding[];
}

export interface QualityDimensions {
  completeness: number;
  validity: number;
  uniqueness: number;
  consistency: number;
}

export interface QualityScoreResult {
  overallScore: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  dimensions: QualityDimensions;
  totalCells: number;
  totalRows: number;
  totalDefects: number;
}

export interface DatasetAnalysisResult {
  datasetMeta: {
    filename: string;
    fileType: 'CSV' | 'XLSX';
    fileSizeBytes?: number;
    totalRows: number;
    totalColumns: number;
    columns: string[];
    truncated?: boolean;
  };
  summary: {
    totalRecords: number;
    missingValues: number;
    duplicateRecords: number;
    invalidFormats: number;
    inconsistentValues: number;
    anomalies: number;
    openIssues: number;
    detailedIssueCount: number;
    qualityScore: number;
    grade: 'A' | 'B' | 'C' | 'D' | 'F';
  };
  missingValues: MissingValueReport;
  duplicates: DuplicateReport;
  invalidFormats: InvalidFormatReport;
  inconsistentValues: InconsistentValueReport;
  anomalies: AnomalyReport;
  qualityScore: QualityScoreResult;
  dimensions: QualityDimensions;
  /** Column-level grouped issues for repair planner & overview charts */
  issues: Omit<QualityIssue, 'id' | 'datasetId'>[];
  /** Row-level granular detected issues with exact 1-based rowNumber */
  detailedIssues: Omit<DetectedIssueRecord, 'id' | 'datasetId'>[];
}
