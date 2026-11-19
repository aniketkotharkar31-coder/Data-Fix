import type {
  AnomalyReport,
  DuplicateReport,
  InconsistentValueReport,
  InvalidFormatReport,
  MissingValueReport,
  QualityScoreResult,
} from './types.ts';

export interface QualityScoreInput {
  totalRows: number;
  totalColumns: number;
  missingValues: MissingValueReport;
  duplicates: DuplicateReport;
  invalidFormats: InvalidFormatReport;
  inconsistentValues: InconsistentValueReport;
  anomalies: AnomalyReport;
}

function clampPercent(ratio: number): number {
  const clamped = Math.max(0, Math.min(1, ratio));
  return Math.round(clamped * 1000) / 10;
}

function scoreToGrade(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (score >= 95) return 'A';
  if (score >= 85) return 'B';
  if (score >= 75) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

/**
 * Computes transparent 4-dimension and overall data quality scores (0–100)
 * from detector outputs without mutating any dataset data.
 */
export function calculateQualityScore(input: QualityScoreInput): QualityScoreResult {
  const { totalRows, totalColumns } = input;
  const totalCells = totalRows * totalColumns;

  if (totalRows <= 0 || totalColumns <= 0 || totalCells <= 0) {
    return {
      overallScore: 100,
      grade: 'A',
      dimensions: {
        completeness: 100,
        validity: 100,
        uniqueness: 100,
        consistency: 100,
      },
      totalCells: 0,
      totalRows: 0,
      totalDefects: 0,
    };
  }

  // Separate format findings into schema-validity defects vs format-consistency drift
  let schemaValidityDefects = 0;
  let formatConsistencyDefects = 0;
  for (const finding of input.invalidFormats.findings) {
    if (finding.category === 'Schema Mismatch') {
      schemaValidityDefects += finding.affectedRows;
    } else {
      formatConsistencyDefects += finding.affectedRows;
    }
  }

  const missingCells = input.missingValues.totalMissingCells;
  const validityDefects = schemaValidityDefects + input.anomalies.totalAnomalies;
  const consistencyDefects =
    formatConsistencyDefects + input.inconsistentValues.totalInconsistentCells;
  const duplicateRows = input.duplicates.totalDuplicateRows;

  const completeness = clampPercent(1 - missingCells / totalCells);
  const validity = clampPercent(1 - validityDefects / totalCells);
  const consistency = clampPercent(1 - consistencyDefects / totalCells);
  const uniqueness = clampPercent(1 - duplicateRows / totalRows);

  const overallScore =
    Math.round(((completeness + validity + consistency + uniqueness) / 4) * 10) / 10;

  return {
    overallScore,
    grade: scoreToGrade(overallScore),
    dimensions: {
      completeness,
      validity,
      uniqueness,
      consistency,
    },
    totalCells,
    totalRows,
    totalDefects:
      missingCells + validityDefects + consistencyDefects + duplicateRows,
  };
}
