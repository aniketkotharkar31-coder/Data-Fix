import { isCellMissing } from './missingValueDetector.ts';
import type {
  FlaggedCellOccurrence,
  InconsistentValueFinding,
  InconsistentValueReport,
  TabularRow,
} from './types.ts';

const EXPLICIT_CODE_COL_RE = /(?:country_?code|currency|currency_?code|state_?code|iso|site_?code|_code$)/i;
const AMBIGUOUS_GEO_COL_RE = /^(?:country|state|site)$/i;
const SHORT_ALPHA_CODE_RE = /^[A-Za-z]{2,3}$/;
const NON_CATEGORICAL_COL_RE =
  /date|timestamp|created|updated|renewal|dispatch|due|intake|dob|birth|amount|cost|price|value|usd|revenue|salary|age|qty|quantity|total|arr|email|mail|phone|mobile|tel|^id$|_id$|_no$|_key$|name|address|notes|description/i;

/**
 * Canonical synonym groups for real-world categorical standardization
 * (e.g., Bangalore -> Bengaluru, Bombay -> Mumbai, UK -> GB, USA -> US).
 */
const CANONICAL_SYNONYM_GROUPS: { canonical: string; aliases: string[] }[] = [
  { canonical: 'Bengaluru', aliases: ['bengaluru', 'bangalore', 'blr'] },
  { canonical: 'Mumbai', aliases: ['mumbai', 'bombay', 'bom'] },
  { canonical: 'Kolkata', aliases: ['kolkata', 'calcutta'] },
  { canonical: 'Chennai', aliases: ['chennai', 'madras'] },
  { canonical: 'Pune', aliases: ['pune', 'poona'] },
  { canonical: 'Gurugram', aliases: ['gurugram', 'gurgaon'] },
  { canonical: 'Mysuru', aliases: ['mysuru', 'mysore'] },
  { canonical: 'Vadodara', aliases: ['vadodara', 'baroda'] },
  { canonical: 'Thiruvananthapuram', aliases: ['thiruvananthapuram', 'trivandrum'] },
  { canonical: 'Kochi', aliases: ['kochi', 'cochin'] },
  { canonical: 'New Delhi', aliases: ['new delhi', 'delhi', 'n. delhi'] },
  { canonical: 'Hyderabad', aliases: ['hyderabad', 'hyd'] },
  { canonical: 'United States', aliases: ['united states', 'usa', 'u.s.a.', 'u.s.', 'us'] },
  { canonical: 'United Kingdom', aliases: ['united kingdom', 'u.k.', 'uk', 'great britain', 'gb'] },
  { canonical: 'United Arab Emirates', aliases: ['united arab emirates', 'uae', 'u.a.e.'] },
  { canonical: 'Male', aliases: ['male', 'm'] },
  { canonical: 'Female', aliases: ['female', 'f'] },
  { canonical: 'Yes', aliases: ['yes', 'y', 'true'] },
  { canonical: 'No', aliases: ['no', 'n', 'false'] },
];

const SYNONYM_LOOKUP = new Map<string, { groupIndex: number; canonical: string }>();
CANONICAL_SYNONYM_GROUPS.forEach((group, groupIndex) => {
  for (const alias of group.aliases) {
    SYNONYM_LOOKUP.set(alias.toLowerCase(), {
      groupIndex,
      canonical: group.canonical,
    });
  }
});

export function normalizeStandardCode(col: string, raw: string): string {
  const trimmed = raw.trim();
  if (/country/i.test(col)) {
    const upper = trimmed.toUpperCase();
    return upper === 'UK' ? 'GB' : upper;
  }
  if (/currency/i.test(col)) {
    return trimmed.toUpperCase();
  }
  return trimmed;
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 2) return 3;
  const prev = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;

  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > 2) return 3;
    for (let j = 0; j <= n; j += 1) prev[j] = curr[j];
  }
  return prev[n];
}

/**
 * Detects categorical inconsistencies including:
 * - Known synonym/alias conflicts (e.g. "Bangalore" vs "Bengaluru")
 * - Fuzzy spelling typos across categorical labels (Levenshtein distance)
 * - Mixed-case categorical variants ("Approved" vs "approved")
 * - Leading/trailing whitespace and ISO/currency code drift
 * Pure function — does not mutate input rows.
 */
export function detectInconsistentValues(
  columns: readonly string[],
  rows: ReadonlyArray<Readonly<TabularRow>>
): InconsistentValueReport {
  if (columns.length === 0 || rows.length === 0) {
    return { totalInconsistentCells: 0, findings: [] };
  }

  const findings: InconsistentValueFinding[] = [];
  let totalInconsistentCells = 0;

  for (const col of columns) {
    let isCodeCol = EXPLICIT_CODE_COL_RE.test(col);
    if (!isCodeCol && AMBIGUOUS_GEO_COL_RE.test(col)) {
      let observedStrings = 0;
      let shortCodeStrings = 0;
      for (const row of rows) {
        const val = row[col];
        if (!isCellMissing(val) && typeof val === 'string') {
          const trimmedVal = val.trim();
          if (trimmedVal.length > 0) {
            observedStrings += 1;
            if (SHORT_ALPHA_CODE_RE.test(trimmedVal)) {
              shortCodeStrings += 1;
            }
          }
        }
      }
      // Only treat ambiguous columns like "country" as ISO codes when nearly all values are 2-3 letter codes
      isCodeCol = observedStrings > 0 && shortCodeStrings / observedStrings >= 0.8;
    }
    const isCategoricalCandidate = !isCodeCol && !NON_CATEGORICAL_COL_RE.test(col);

    const driftCells: FlaggedCellOccurrence[] = [];
    const driftVariants = new Set<string>();

    // Track exact trimmed variants for categorical analysis
    const valueCounts = new Map<string, number[]>();
    const canonicalCaseMap = new Map<string, Map<string, number[]>>();
    const synonymGroupHits = new Map<number, Map<string, number[]>>();

    for (let i = 0; i < rows.length; i += 1) {
      const val = rows[i][col];
      if (isCellMissing(val) || typeof val !== 'string') continue;

      const trimmed = val.trim();
      const hasWhitespaceDrift = val !== trimmed;
      const normalizedCode = isCodeCol ? normalizeStandardCode(col, val) : trimmed;
      const hasCodeDrift = isCodeCol && normalizedCode !== val;

      if (hasWhitespaceDrift || hasCodeDrift) {
        driftCells.push({
          rowIndex: i,
          originalValue: val,
          suggestedValue: isCodeCol ? normalizedCode : trimmed,
        });
        driftVariants.add(val);
      }

      if (isCategoricalCandidate && trimmed.length > 0 && trimmed.length <= 48) {
        const list = valueCounts.get(trimmed) ?? [];
        list.push(i);
        valueCounts.set(trimmed, list);

        const lowerKey = trimmed.toLowerCase();
        let caseBucket = canonicalCaseMap.get(lowerKey);
        if (!caseBucket) {
          caseBucket = new Map();
          canonicalCaseMap.set(lowerKey, caseBucket);
        }
        const caseRows = caseBucket.get(trimmed) ?? [];
        caseRows.push(i);
        caseBucket.set(trimmed, caseRows);

        const synMatch = SYNONYM_LOOKUP.get(lowerKey);
        if (synMatch) {
          let groupMap = synonymGroupHits.get(synMatch.groupIndex);
          if (!groupMap) {
            groupMap = new Map();
            synonymGroupHits.set(synMatch.groupIndex, groupMap);
          }
          const synRows = groupMap.get(trimmed) ?? [];
          synRows.push(i);
          groupMap.set(trimmed, synRows);
        }
      }
    }

    if (driftCells.length > 0) {
      totalInconsistentCells += driftCells.length;
      const firstSample = driftCells[0].originalValue;
      findings.push({
        column: col,
        issueType: isCodeCol ? 'code_standardization' : 'whitespace_drift',
        severity: isCodeCol ? 'Warning' : 'Info',
        affectedRows: driftCells.length,
        rowIndices: driftCells.map((c) => c.rowIndex),
        cells: driftCells,
        sampleValue: firstSample.includes(' ') ? `"${firstSample}"` : firstSample,
        variants: Array.from(driftVariants).slice(0, 5),
        ruleTriggered: isCodeCol
          ? 'Standardized ISO code casing & trim'
          : 'Leading/trailing whitespace check',
      });
    }

    if (!isCategoricalCandidate) continue;

    const alreadyFlaggedRowSet = new Set<number>();

    // 1. Canonical Synonym / Geographic Alias Conflicts (e.g. Bangalore vs Bengaluru)
    const synonymCells: FlaggedCellOccurrence[] = [];
    const synonymVariants: string[] = [];
    let primaryCanonical: string | undefined;

    for (const [groupIndex, variantMap] of synonymGroupHits.entries()) {
      // Only flag if 2+ distinct variants from the same canonical group appear in this column
      const distinctLower = new Set(
        Array.from(variantMap.keys()).map((v) => v.toLowerCase())
      );
      if (distinctLower.size < 2) continue;

      const canonical = CANONICAL_SYNONYM_GROUPS[groupIndex].canonical;
      // Prefer the canonical name if present in the dataset, otherwise the most frequent variant
      const sorted = Array.from(variantMap.entries()).sort(
        (a, b) => b[1].length - a[1].length
      );
      const hasCanonicalExact = sorted.some(
        ([label]) => label.toLowerCase() === canonical.toLowerCase()
      );
      const targetStandard = hasCanonicalExact ? canonical : sorted[0][0];
      if (!primaryCanonical) primaryCanonical = targetStandard;

      for (const [variant, indices] of sorted) {
        if (synonymVariants.length < 6) synonymVariants.push(variant);
        if (variant !== targetStandard) {
          for (const rowIdx of indices) {
            alreadyFlaggedRowSet.add(rowIdx);
            synonymCells.push({
              rowIndex: rowIdx,
              originalValue: variant,
              suggestedValue: targetStandard,
              detail: `Inconsistent categorical label "${variant}" conflicts with "${targetStandard}" in column "${col}".`,
            });
          }
        }
      }
    }

    if (synonymCells.length > 0) {
      totalInconsistentCells += synonymCells.length;
      findings.push({
        column: col,
        issueType: 'categorical_synonym',
        severity: 'Warning',
        affectedRows: synonymCells.length,
        rowIndices: synonymCells.map((c) => c.rowIndex),
        cells: synonymCells,
        sampleValue: synonymVariants.slice(0, 2).join(' vs '),
        canonicalValue: primaryCanonical,
        variants: synonymVariants,
        ruleTriggered: 'Canonical categorical value standardization',
      });
    }

    // 2. Mixed-case categorical variants (e.g., "Approved" vs "approved")
    const mixedCaseCells: FlaggedCellOccurrence[] = [];
    const mixedVariants: string[] = [];

    for (const caseBucket of canonicalCaseMap.values()) {
      if (caseBucket.size <= 1) continue;
      const sortedVariants = Array.from(caseBucket.entries()).sort(
        (a, b) => b[1].length - a[1].length
      );
      const dominant = sortedVariants[0][0];
      for (const [variant] of sortedVariants) {
        if (mixedVariants.length < 6) mixedVariants.push(variant);
      }
      for (let v = 1; v < sortedVariants.length; v += 1) {
        const [variant, indices] = sortedVariants[v];
        for (const rowIdx of indices) {
          if (alreadyFlaggedRowSet.has(rowIdx)) continue;
          alreadyFlaggedRowSet.add(rowIdx);
          mixedCaseCells.push({
            rowIndex: rowIdx,
            originalValue: variant,
            suggestedValue: dominant,
            detail: `Case inconsistency: "${variant}" differs in capitalization from dominant value "${dominant}".`,
          });
        }
      }
    }

    if (mixedCaseCells.length > 0) {
      totalInconsistentCells += mixedCaseCells.length;
      findings.push({
        column: col,
        issueType: 'case_inconsistency',
        severity: 'Info',
        affectedRows: mixedCaseCells.length,
        rowIndices: mixedCaseCells.map((c) => c.rowIndex),
        cells: mixedCaseCells,
        sampleValue: mixedVariants.slice(0, 2).join(' vs '),
        variants: mixedVariants,
        ruleTriggered: 'Consistent categorical value casing',
      });
    }

    // 3. Fuzzy near-duplicate spelling inconsistencies (Levenshtein distance <= 1 or 2)
    // Only run on columns with reasonable cardinality (<= 60 distinct values) to stay fast on large files
    const distinctValues = Array.from(valueCounts.entries())
      .filter(([val]) => val.length >= 5)
      .sort((a, b) => b[1].length - a[1].length);

    if (distinctValues.length >= 2 && distinctValues.length <= 60) {
      const fuzzyCells: FlaggedCellOccurrence[] = [];
      const fuzzyVariants: string[] = [];
      const matchedMinorities = new Set<string>();

      for (let i = 0; i < distinctValues.length; i += 1) {
        const [majorVal, majorRows] = distinctValues[i];
        if (matchedMinorities.has(majorVal)) continue;
        const majorLower = majorVal.toLowerCase();

        for (let j = i + 1; j < distinctValues.length; j += 1) {
          const [minorVal, minorRows] = distinctValues[j];
          if (matchedMinorities.has(minorVal)) continue;
          const minorLower = minorVal.toLowerCase();
          if (majorLower === minorLower) continue;

          // Skip if both are already in a synonym group handled above
          const synA = SYNONYM_LOOKUP.get(majorLower);
          const synB = SYNONYM_LOOKUP.get(minorLower);
          if (synA && synB && synA.groupIndex === synB.groupIndex) continue;

          // Only cluster when dominant spelling appears more often (or equal for clear 1-edit typo on long words)
          if (majorRows.length < minorRows.length) continue;

          const maxEdit = majorLower.length >= 8 && minorLower.length >= 8 ? 2 : 1;
          const dist = levenshteinDistance(majorLower, minorLower);
          if (dist > 0 && dist <= maxEdit && majorLower[0] === minorLower[0]) {
            matchedMinorities.add(minorVal);
            if (fuzzyVariants.length < 6) {
              fuzzyVariants.push(`${minorVal} / ${majorVal}`);
            }
            for (const rowIdx of minorRows) {
              if (alreadyFlaggedRowSet.has(rowIdx)) continue;
              alreadyFlaggedRowSet.add(rowIdx);
              fuzzyCells.push({
                rowIndex: rowIdx,
                originalValue: minorVal,
                suggestedValue: majorVal,
                detail: `Possible spelling inconsistency: "${minorVal}" closely matches dominant value "${majorVal}".`,
              });
            }
          }
        }
      }

      if (fuzzyCells.length > 0) {
        totalInconsistentCells += fuzzyCells.length;
        findings.push({
          column: col,
          issueType: 'fuzzy_spelling',
          severity: 'Warning',
          affectedRows: fuzzyCells.length,
          rowIndices: fuzzyCells.map((c) => c.rowIndex),
          cells: fuzzyCells,
          sampleValue: fuzzyVariants[0] ?? fuzzyCells[0].originalValue,
          variants: fuzzyVariants,
          ruleTriggered: 'Fuzzy categorical spelling consistency check',
        });
      }
    }
  }

  return { totalInconsistentCells, findings };
}
