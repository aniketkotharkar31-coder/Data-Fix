import { parseCurrencyString } from './invalidFormatDetector.ts';
import { isCellMissing } from './missingValueDetector.ts';
import type {
  AnomalyFinding,
  AnomalyReport,
  FlaggedCellOccurrence,
  TabularRow,
} from './types.ts';

const NON_NEGATIVE_COL_RE = /amount|cost|price|value|usd|revenue|salary|age|qty|quantity|total|arr/i;
const AGE_COL_RE = /(^age$|age_years|customer_age|patient_age)/i;
const EXCLUDED_IQR_COL_RE = /(^id$|_id$|_no$|_key$|zip|postal|phone|mobile|tel|year$)/i;

function computePercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
}

function roundTwo(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Detects numerical anomalies using:
 * 1. The Tukey IQR statistical method (Q1 - 1.5*IQR to Q3 + 1.5*IQR) on numerical columns
 * 2. Non-negative business boundary checks (< 0)
 * 3. Domain bounds (e.g., age > 130)
 * Pure function — does not mutate input rows.
 */
export function detectAnomalies(
  columns: readonly string[],
  rows: ReadonlyArray<Readonly<TabularRow>>
): AnomalyReport {
  if (columns.length === 0 || rows.length === 0) {
    return { totalAnomalies: 0, findings: [] };
  }

  const findings: AnomalyFinding[] = [];
  let totalAnomalies = 0;

  for (const col of columns) {
    const isNonNegativeCol = NON_NEGATIVE_COL_RE.test(col);
    const isAgeCol = AGE_COL_RE.test(col);
    const isExcludedFromIqr = EXCLUDED_IQR_COL_RE.test(col);

    const allNumericSamples: { idx: number; value: number; raw: string }[] = [];
    let nonNullCount = 0;

    for (let i = 0; i < rows.length; i += 1) {
      const val = rows[i][col];
      if (isCellMissing(val)) continue;
      nonNullCount += 1;

      if (typeof val === 'number' && Number.isFinite(val)) {
        allNumericSamples.push({ idx: i, value: val, raw: String(val) });
      } else if (typeof val === 'string') {
        const trimmed = val.trim();
        if (/^-?\d{1,3}(?:,\d{3})*(?:\.\d+)?$|^-?\d+(?:\.\d+)?$/.test(trimmed)) {
          const n = Number(trimmed.replace(/,/g, ''));
          if (Number.isFinite(n)) {
            allNumericSamples.push({ idx: i, value: n, raw: val });
          }
        } else if (isNonNegativeCol) {
          const curr = parseCurrencyString(trimmed);
          if (curr !== null) {
            allNumericSamples.push({ idx: i, value: curr, raw: val });
          }
        }
      }
    }

    const numericDensity =
      nonNullCount > 0 ? allNumericSamples.length / nonNullCount : 0;
    const isNumericSeries =
      isNonNegativeCol || (!isExcludedFromIqr && numericDensity >= 0.7);

    if (!isNumericSeries || allNumericSamples.length === 0) continue;

    const flaggedRowsInCol = new Set<number>();

    // 1. Non-negative business boundary check (< 0)
    const negativeCells: FlaggedCellOccurrence[] = [];
    if (isNonNegativeCol) {
      for (const sample of allNumericSamples) {
        if (sample.value < 0) {
          flaggedRowsInCol.add(sample.idx);
          negativeCells.push({
            rowIndex: sample.idx,
            originalValue: sample.raw,
            suggestedValue: String(Math.abs(sample.value)),
            detail: `Negative value ${sample.value} violates non-negative boundary (>= 0) in column "${col}".`,
          });
        }
      }
    }

    if (negativeCells.length > 0) {
      totalAnomalies += negativeCells.length;
      findings.push({
        column: col,
        anomalyType: 'negative_boundary',
        severity: 'Warning',
        affectedRows: negativeCells.length,
        rowIndices: negativeCells.map((c) => c.rowIndex),
        cells: negativeCells,
        sampleValue: negativeCells[0].originalValue,
        bounds: { min: 0, max: Number.POSITIVE_INFINITY },
        ruleTriggered: 'Non-negative value boundary (>= 0)',
      });
    }

    // 2. Domain range check (e.g., age > 130)
    const domainCells: FlaggedCellOccurrence[] = [];
    if (isAgeCol) {
      for (const sample of allNumericSamples) {
        if (flaggedRowsInCol.has(sample.idx)) continue;
        if (sample.value > 130) {
          flaggedRowsInCol.add(sample.idx);
          domainCells.push({
            rowIndex: sample.idx,
            originalValue: sample.raw,
            detail: `Age value ${sample.value} exceeds realistic human age range (0–130).`,
          });
        }
      }
    }

    if (domainCells.length > 0) {
      totalAnomalies += domainCells.length;
      findings.push({
        column: col,
        anomalyType: 'domain_range',
        severity: 'Warning',
        affectedRows: domainCells.length,
        rowIndices: domainCells.map((c) => c.rowIndex),
        cells: domainCells,
        sampleValue: domainCells[0].originalValue,
        bounds: { min: 0, max: 130 },
        ruleTriggered: 'Valid age domain range (0–130)',
      });
    }

    // 3. Tukey IQR Statistical Outlier Method (Q1 - 1.5*IQR to Q3 + 1.5*IQR)
    const iqrCandidates = allNumericSamples.filter(
      (s) => !flaggedRowsInCol.has(s.idx)
    );
    if (!isExcludedFromIqr && iqrCandidates.length >= 4) {
      const sortedValues = iqrCandidates
        .map((s) => s.value)
        .sort((a, b) => a - b);
      const q1 = computePercentile(sortedValues, 0.25);
      const q3 = computePercentile(sortedValues, 0.75);
      const iqr = q3 - q1;

      if (iqr > 0) {
        const lowerFence = q1 - 1.5 * iqr;
        const upperFence = q3 + 1.5 * iqr;
        const outlierCells: FlaggedCellOccurrence[] = [];

        for (const sample of iqrCandidates) {
          if (sample.value < lowerFence || sample.value > upperFence) {
            flaggedRowsInCol.add(sample.idx);
            const direction = sample.value > upperFence ? 'exceeds upper' : 'falls below lower';
            outlierCells.push({
              rowIndex: sample.idx,
              originalValue: sample.raw,
              detail: `Numerical anomaly: ${sample.value} ${direction} IQR fence [${roundTwo(lowerFence)}, ${roundTwo(upperFence)}] (Q1=${roundTwo(q1)}, Q3=${roundTwo(q3)}, IQR=${roundTwo(iqr)}).`,
            });
          }
        }

        if (outlierCells.length > 0) {
          totalAnomalies += outlierCells.length;
          findings.push({
            column: col,
            anomalyType: 'statistical_outlier',
            severity: 'Warning',
            affectedRows: outlierCells.length,
            rowIndices: outlierCells.map((c) => c.rowIndex),
            cells: outlierCells,
            sampleValue: outlierCells[0].originalValue,
            bounds: {
              min: roundTwo(lowerFence),
              max: roundTwo(upperFence),
              q1: roundTwo(q1),
              q3: roundTwo(q3),
              iqr: roundTwo(iqr),
            },
            ruleTriggered: `IQR statistical outlier fence [${roundTwo(lowerFence)}, ${roundTwo(upperFence)}]`,
          });
        }
      } else {
        // Fallback when IQR === 0 (constant majority distribution, e.g. [100, 100, 100, 100, 99999])
        const medianVal = computePercentile(sortedValues, 0.5);
        const majorityCount = sortedValues.filter((v) => v === medianVal).length;
        if (majorityCount / sortedValues.length >= 0.6) {
          const minExtremeDelta =
            medianVal !== 0 ? Math.max(Math.abs(medianVal) * 3, 10) : 100;
          const outlierCells: FlaggedCellOccurrence[] = [];

          for (const sample of iqrCandidates) {
            if (Math.abs(sample.value - medianVal) > minExtremeDelta) {
              flaggedRowsInCol.add(sample.idx);
              outlierCells.push({
                rowIndex: sample.idx,
                originalValue: sample.raw,
                detail: `Numerical anomaly: ${sample.value} deviates sharply from constant-majority baseline ${roundTwo(medianVal)} (Q1=${roundTwo(q1)}, Q3=${roundTwo(q3)}, IQR=0).`,
              });
            }
          }

          if (outlierCells.length > 0) {
            totalAnomalies += outlierCells.length;
            findings.push({
              column: col,
              anomalyType: 'statistical_outlier',
              severity: 'Warning',
              affectedRows: outlierCells.length,
              rowIndices: outlierCells.map((c) => c.rowIndex),
              cells: outlierCells,
              sampleValue: outlierCells[0].originalValue,
              bounds: {
                min: roundTwo(medianVal - minExtremeDelta),
                max: roundTwo(medianVal + minExtremeDelta),
                q1: roundTwo(q1),
                q3: roundTwo(q3),
                iqr: 0,
              },
              ruleTriggered: `IQR constant-majority outlier check (baseline ${roundTwo(medianVal)})`,
            });
          }
        }
      }
    }
  }

  return { totalAnomalies, findings };
}
