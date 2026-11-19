import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeDataset } from './datasetAnalyzer.ts';
import {
  applyApprovedRepairSuggestions,
  generateRepairSuggestions,
} from './repairEngine.ts';
import type { DataRow } from '../../src/types/datafix.ts';

function buildTestDataset(): { columns: string[]; rows: DataRow[] } {
  const columns = [
    'emp_id',
    'email',
    'department',
    'city',
    'hire_date',
    'score',
    'salary',
  ];
  const rows: DataRow[] = [
    {
      emp_id: 'E001',
      email: 'asha@acme.com',
      department: 'Engineering',
      city: 'Bengaluru',
      hire_date: '2025-01-10',
      score: 80,
      salary: 80000,
    },
    {
      emp_id: 'E002',
      email: 'amitgmail.com',
      department: 'Engineering',
      city: 'Bangalore',
      hire_date: '15/03/2025',
      score: 90,
      salary: 82000,
    },
    {
      emp_id: 'E003',
      email: null,
      department: null,
      city: ' Bengaluru ',
      hire_date: '2025-02-30',
      score: null,
      salary: 84000,
    },
    {
      emp_id: 'E001',
      email: 'asha@acme.com',
      department: 'Engineering',
      city: 'Bengaluru',
      hire_date: '2025-01-10',
      score: 80,
      salary: 80000,
    },
    {
      emp_id: 'E005',
      email: 'vikram@acme.com',
      department: 'Sales',
      city: 'Bengaluru',
      hire_date: '2025-04-01',
      score: 100,
      salary: 83000,
    },
    {
      emp_id: 'E006',
      email: 'priya@acme.com',
      department: 'Engineering',
      city: 'Bengaluru',
      hire_date: '2025-05-01',
      score: 90,
      salary: 950000,
    },
  ];
  return { columns, rows };
}

test('generateRepairSuggestions() covers all 5 categories with mean/median/mode, duplicates, dates/spaces, synonyms, and manual-review anomalies without inventing PII', () => {
  const { columns, rows } = buildTestDataset();
  const analysis = analyzeDataset({
    filename: 'repair_test.csv',
    fileType: 'CSV',
    columns,
    rows,
  });

  const suggestions = generateRepairSuggestions(
    'ds-rep',
    'repair_test.csv',
    analysis,
    rows
  );

  // 1a. Missing numeric column ("score"): offers BOTH Mean (88) and Median (90)
  const numericMissing = suggestions.find(
    (s) => s.issueType === 'Missing Values' && s.column === 'score' && s.rowNumber === 3
  );
  assert.ok(numericMissing);
  assert.equal(numericMissing.manualReviewOnly, false);
  assert.equal(numericMissing.imputationOptions?.meanValue, 88);
  assert.equal(numericMissing.imputationOptions?.medianValue, 90);

  // 1b. Missing categorical column ("department"): offers Mode imputation ("Engineering")
  const catMissing = suggestions.find(
    (s) => s.issueType === 'Missing Values' && s.column === 'department' && s.rowNumber === 3
  );
  assert.ok(catMissing);
  assert.equal(catMissing.manualReviewOnly, false);
  assert.equal(catMissing.repairMethod, 'Mode Imputation');
  assert.equal(catMissing.proposedValue, 'Engineering');

  // 1c. Missing personal info ("email"): NEVER invents missing email — manualReviewOnly
  const emailMissing = suggestions.find(
    (s) => s.issueType === 'Missing Values' && s.column === 'email' && s.rowNumber === 3
  );
  assert.ok(emailMissing);
  assert.equal(emailMissing.manualReviewOnly, true);
  assert.equal(emailMissing.proposedRawValue, null);
  assert.match(emailMissing.repairMethod, /Manual Review/i);

  // 2. Duplicate record (Row 4 matches Row 1)
  const dup = suggestions.find(
    (s) => s.issueType === 'Duplicate Records' && s.rowNumber === 4
  );
  assert.ok(dup);
  assert.equal(dup.manualReviewOnly, false);
  assert.equal(dup.operationType, 'remove_duplicate_row');
  assert.equal(dup.confidenceLevel, 'High');

  // 3a. Valid regional date (Row 2: 15/03/2025 -> 2025-03-15)
  const validDate = suggestions.find(
    (s) => s.issueType === 'Invalid Formats' && s.column === 'hire_date' && s.rowNumber === 2
  );
  assert.ok(validDate);
  assert.equal(validDate.manualReviewOnly, false);
  assert.equal(validDate.proposedValue, '2025-03-15');
  assert.equal(validDate.repairMethod, 'Normalize Date Format');

  // 3b. Impossible date (Row 3: 2025-02-30) and invalid email (Row 2: amitgmail.com) -> manual review, never invented
  const badDate = suggestions.find(
    (s) => s.issueType === 'Invalid Formats' && s.column === 'hire_date' && s.rowNumber === 3
  );
  assert.ok(badDate);
  assert.equal(badDate.manualReviewOnly, true);

  const badEmail = suggestions.find(
    (s) => s.issueType === 'Invalid Formats' && s.column === 'email' && s.rowNumber === 2
  );
  assert.ok(badEmail);
  assert.equal(badEmail.manualReviewOnly, true);

  // 4. Inconsistent category ("Bangalore" -> "Bengaluru") and whitespace (" Bengaluru " -> "Bengaluru")
  const citySynonym = suggestions.find(
    (s) =>
      s.issueType === 'Inconsistent Values' &&
      s.column === 'city' &&
      s.rowNumber === 2
  );
  assert.ok(citySynonym);
  assert.equal(citySynonym.proposedValue, 'Bengaluru');
  assert.equal(citySynonym.repairMethod, 'Standardize Category');

  const citySpace = suggestions.find(
    (s) =>
      s.issueType === 'Inconsistent Values' &&
      s.column === 'city' &&
      s.rowNumber === 3
  );
  assert.ok(citySpace);
  assert.equal(citySpace.proposedValue, 'Bengaluru');
  assert.equal(citySpace.repairMethod, 'Trim Unnecessary Spaces');

  // 5. Anomaly (Row 6 salary 950000): highlighted for manual review, never auto-modified
  const anomaly = suggestions.find(
    (s) => s.issueType === 'Anomalies' && s.column === 'salary' && s.rowNumber === 6
  );
  assert.ok(anomaly);
  assert.equal(anomaly.manualReviewOnly, true);
  assert.match(anomaly.proposedValue, /Manual Review/i);
});

test('applyApprovedRepairSuggestions() applies ONLY approved changes, respects mean/median selection, preserves original rows, and records modification history', () => {
  const { columns, rows } = buildTestDataset();
  const originalSnapshot = JSON.stringify(rows);

  const analysis = analyzeDataset({
    filename: 'repair_test.csv',
    fileType: 'CSV',
    columns,
    rows,
  });
  const suggestions = generateRepairSuggestions(
    'ds-rep',
    'repair_test.csv',
    analysis,
    rows
  );

  const numericMissing = suggestions.find(
    (s) => s.issueType === 'Missing Values' && s.column === 'score'
  )!;
  const catMissing = suggestions.find(
    (s) => s.issueType === 'Missing Values' && s.column === 'department'
  )!;
  const dup = suggestions.find((s) => s.issueType === 'Duplicate Records')!;
  const dateFix = suggestions.find(
    (s) => s.column === 'hire_date' && s.rowNumber === 2
  )!;
  const citySynonym = suggestions.find(
    (s) => s.column === 'city' && s.rowNumber === 2
  )!;
  const anomaly = suggestions.find((s) => s.issueType === 'Anomalies')!;
  const emailMissing = suggestions.find(
    (s) => s.issueType === 'Missing Values' && s.column === 'email'
  )!;

  // Approve numeric missing with explicit MEDIAN choice, categorical mode, duplicate removal, date fix,
  // plus attempt to pass manualReviewOnly anomaly & missing email (both must be skipped!)
  // Deliberately leave citySynonym UNAPPROVED to verify unapproved suggestions stay unchanged.
  const result = applyApprovedRepairSuggestions({
    datasetId: 'ds-rep',
    datasetName: 'repair_test.csv',
    columns,
    currentRows: rows,
    suggestions,
    approvals: [
      { suggestionId: numericMissing.id, imputationMethod: 'median' },
      { suggestionId: catMissing.id },
      { suggestionId: dup.id },
      { suggestionId: dateFix.id },
      { suggestionId: anomaly.id },
      { suggestionId: emailMissing.id },
    ],
  });

  // Original rows MUST remain completely unchanged
  assert.equal(JSON.stringify(rows), originalSnapshot);

  // Manual review items were safely skipped
  assert.equal(result.skippedManualReviewCount, 2);

  // Duplicate Row 4 removed -> 5 rows remaining
  assert.equal(result.rowsRemoved, 1);
  assert.equal(result.updatedRows.length, 5);

  // Approved repairs applied accurately
  assert.equal(result.updatedRows[1].hire_date, '2025-03-15');
  assert.equal(result.updatedRows[2].score, 90); // Median selected
  assert.equal(result.updatedRows[2].department, 'Engineering'); // Mode

  // Unapproved repair ("Bangalore") was NOT modified
  assert.equal(result.updatedRows[1].city, 'Bangalore');

  // Missing PII ("email") and Anomaly ("salary" 950000) were NOT modified
  assert.equal(result.updatedRows[2].email, null);
  assert.equal(result.updatedRows[4].salary, 950000);

  // Modification history captured every applied change
  assert.equal(result.historyEntries.length, 4);
  assert.ok(
    result.historyEntries.some(
      (h) =>
        h.column === 'score' &&
        h.repairMethod === 'Median Imputation' &&
        h.newValue === '90'
    )
  );
  assert.ok(
    result.historyEntries.some(
      (h) => h.action === 'Row Removed' && h.rowNumber === 4
    )
  );
  assert.ok(citySynonym); // verify unapproved existed
});
