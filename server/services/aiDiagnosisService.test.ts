import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GeminiDiagnosisError,
  diagnoseDetectedIssues,
  enforceSafetyGuardrails,
} from './aiDiagnosisService.ts';
import type { DetectedIssueRecord } from '../../src/types/datafix.ts';

const SAMPLE_DETECTED_ISSUES: DetectedIssueRecord[] = [
  {
    id: 'det-1',
    datasetId: 'ds-test',
    datasetName: 'contacts_q4.csv',
    issueType: 'Invalid Formats',
    column: 'email',
    rowNumber: 2,
    originalValue: 'amitgmail.com',
    description: 'Invalid email address "amitgmail.com" in column "email".',
    severity: 'Warning',
    suggestedAction: 'Correct to a valid email address format (name@domain.tld).',
  },
  {
    id: 'det-2',
    datasetId: 'ds-test',
    datasetName: 'contacts_q4.csv',
    issueType: 'Missing Values',
    column: 'email',
    rowNumber: 3,
    originalValue: '(empty)',
    description: 'Missing or empty cell in required column "email".',
    severity: 'Critical',
    suggestedAction: 'Impute missing value in "email" or populate from source system.',
  },
  {
    id: 'det-3',
    datasetId: 'ds-test',
    datasetName: 'contacts_q4.csv',
    issueType: 'Inconsistent Values',
    column: 'city',
    rowNumber: 4,
    originalValue: 'Bangalore',
    description:
      'Inconsistent categorical label "Bangalore" conflicts with "Bengaluru" in column "city".',
    severity: 'Warning',
    suggestedAction: 'Standardize value to "Bengaluru".',
  },
];

test('diagnoseDetectedIssues() returns structured JSON separating actual findings from AI suggestions for all 5 fields', async () => {
  const inputSnapshot = JSON.stringify(SAMPLE_DETECTED_ISSUES);

  const result = await diagnoseDetectedIssues({
    datasetId: 'ds-test',
    datasetName: 'contacts_q4.csv',
    columns: ['id', 'name', 'email', 'city'],
    totalRows: 5,
    issues: SAMPLE_DETECTED_ISSUES,
    generateContentFn: async () =>
      JSON.stringify({
        diagnoses: [
          {
            issueId: 'det-1',
            issueExplanation:
              'The email cell "amitgmail.com" fails RFC email syntax because it lacks an "@" separator between local part and domain.',
            possibleRootCause:
              'Missing "@" symbol omitted during manual keyboard entry or copy-paste.',
            recommendedRepair:
              'Confirm with the contact whether "amit@gmail.com" is intended; do not overwrite automatically without verification.',
            recommendationReason:
              'The string contains the well-known domain suffix "gmail.com" directly after "amit", giving strong structural evidence of an omitted "@", though user confirmation is safer.',
            confidenceScore: 84,
            requiresManualReview: false,
            suggestedValue: 'amit@gmail.com',
          },
          {
            issueId: 'det-2',
            issueExplanation: 'Row 3 has no email address recorded in the required email column.',
            possibleRootCause:
              'Optional signup form field or incomplete CRM export omitted contact email.',
            recommendedRepair:
              'Recommend manual review to obtain the verified email from the source CRM record.',
            recommendationReason:
              'No objective evidence exists in the row to determine a person’s email address without inventing personal information.',
            confidenceScore: 45,
            requiresManualReview: true,
            suggestedValue: '',
          },
          {
            issueId: 'det-3',
            issueExplanation:
              'Row 4 uses the legacy city spelling "Bangalore" while other rows standardize on "Bengaluru".',
            possibleRootCause:
              'Free-text city entry without a controlled dropdown or geographic lookup table.',
            recommendedRepair: 'Standardize "Bangalore" to "Bengaluru" to match canonical dataset labels.',
            recommendationReason:
              'Both terms unambiguously refer to the same city and canonicalizing aligns downstream grouping.',
            confidenceScore: 95,
            requiresManualReview: false,
            suggestedValue: 'Bengaluru',
          },
        ],
      }),
  });

  // Verify immutability of original input records
  assert.equal(JSON.stringify(SAMPLE_DETECTED_ISSUES), inputSnapshot);
  assert.equal(result.originalRecordsModified, false);
  assert.equal(result.totalDetectedIssues, 3);
  assert.equal(result.diagnosedCount, 3);
  assert.equal(result.manualReviewCount, 1);

  const emailFinding = result.diagnoses[0];
  assert.equal(emailFinding.source, 'Gemini AI');
  assert.equal(emailFinding.actualFinding?.originalValue, 'amitgmail.com');
  assert.equal(emailFinding.actualFinding?.rowNumber, 2);
  assert.equal(emailFinding.actualFinding?.issueType, 'Invalid Formats');
  assert.ok(emailFinding.aiSuggestion?.issueExplanation.includes('@'));
  assert.ok(emailFinding.aiSuggestion?.possibleRootCause.includes('Missing'));
  assert.ok(emailFinding.aiSuggestion?.recommendedRepair.includes('amit@gmail.com'));
  assert.ok(emailFinding.aiSuggestion?.recommendationReason.length);
  assert.equal(emailFinding.aiSuggestion?.confidenceScore, 84);
  assert.equal(emailFinding.aiSuggestion?.confidenceLevel, 'High');
  assert.equal(emailFinding.aiSuggestion?.suggestedValue, 'amit@gmail.com');

  const missingFinding = result.diagnoses[1];
  assert.equal(missingFinding.aiSuggestion?.requiresManualReview, true);
  assert.equal(missingFinding.aiSuggestion?.suggestedValue, null);
  assert.equal(missingFinding.aiSuggestion?.confidenceLevel, 'Low');

  const cityFinding = result.diagnoses[2];
  assert.equal(cityFinding.aiSuggestion?.suggestedValue, 'Bengaluru');
  assert.equal(cityFinding.aiSuggestion?.confidenceScore, 95);
});

test('enforceSafetyGuardrails() blocks fabricated personal information on missing PII columns', () => {
  const missingEmailIssue = SAMPLE_DETECTED_ISSUES[1];
  const guarded = enforceSafetyGuardrails(
    missingEmailIssue,
    {
      issueId: missingEmailIssue.id,
      issueExplanation: 'Missing email cell.',
      possibleRootCause: 'Blank field during upload.',
      recommendedRepair: 'Fill in placeholder@example.com',
      recommendationReason: 'Email should not be blank.',
      confidenceScore: 92,
      requiresManualReview: false,
      suggestedValue: 'fabricated@example.com',
    },
    'gemini-4-hydrogen',
    '2026-11-18T12:00:00.000Z'
  );

  assert.equal(guarded.requiresManualReview, true);
  assert.equal(guarded.suggestedValue, null);
  assert.ok(guarded.confidenceScore <= 65);
  assert.match(guarded.recommendedRepair, /manual review/i);
});

test('diagnoseDetectedIssues() retries transient 429 rate-limit failures and succeeds', async () => {
  let attempts = 0;
  const delays: number[] = [];

  const result = await diagnoseDetectedIssues({
    datasetId: 'ds-retry',
    datasetName: 'retry_test.csv',
    issues: [SAMPLE_DETECTED_ISSUES[0]],
    maxRetries: 2,
    baseDelayMs: 50,
    sleepFn: async (ms) => {
      delays.push(ms);
    },
    generateContentFn: async () => {
      attempts += 1;
      if (attempts === 1) {
        const err = new Error('429 RESOURCE_EXHAUSTED: rate limit exceeded') as Error & {
          status: number;
        };
        err.status = 429;
        throw err;
      }
      return JSON.stringify({
        diagnoses: [
          {
            issueId: 'det-1',
            issueExplanation: 'Invalid email format without @ symbol.',
            possibleRootCause: 'Missing @ symbol.',
            recommendedRepair: 'Verify and insert @ symbol before gmail.com.',
            recommendationReason: 'Clear structural domain pattern.',
            confidenceScore: 80,
            requiresManualReview: false,
            suggestedValue: 'amit@gmail.com',
          },
        ],
      });
    },
  });

  assert.equal(attempts, 2);
  assert.deepEqual(delays, [50]);
  assert.equal(result.diagnosedCount, 1);
});

test('diagnoseDetectedIssues() classifies auth, rate-limit, empty-issue, and parse failures cleanly', async () => {
  await assert.rejects(
    () =>
      diagnoseDetectedIssues({
        datasetName: 'empty.csv',
        issues: [],
      }),
    (err: unknown) =>
      err instanceof GeminiDiagnosisError &&
      err.code === 'NO_ISSUES_TO_DIAGNOSE' &&
      err.statusCode === 400
  );

  await assert.rejects(
    () =>
      diagnoseDetectedIssues({
        datasetName: 'auth_fail.csv',
        issues: [SAMPLE_DETECTED_ISSUES[0]],
        maxRetries: 1,
        sleepFn: async () => {},
        generateContentFn: async () => {
          const err = new Error('PERMISSION_DENIED: API key not valid') as Error & {
            status: number;
          };
          err.status = 403;
          throw err;
        },
      }),
    (err: unknown) =>
      err instanceof GeminiDiagnosisError &&
      err.code === 'GEMINI_AUTH_ERROR' &&
      err.statusCode === 502 &&
      err.retryable === false
  );

  await assert.rejects(
    () =>
      diagnoseDetectedIssues({
        datasetName: 'bad_json.csv',
        issues: [SAMPLE_DETECTED_ISSUES[0]],
        maxRetries: 0,
        sleepFn: async () => {},
        generateContentFn: async () => 'not valid json {{{',
      }),
    (err: unknown) =>
      err instanceof GeminiDiagnosisError &&
      err.code === 'GEMINI_PARSE_ERROR' &&
      err.statusCode === 502
  );
});
