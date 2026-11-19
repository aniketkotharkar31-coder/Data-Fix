import { ThinkingLevel, Type, type GenerateContentResponse } from '@google/genai';
import {
  DEFAULT_GEMINI_MODEL,
  createGeminiClient,
  isGeminiConfigured,
} from '../config/gemini.ts';
import type {
  AiDiagnosisRunResult,
  DetectedIssueRecord,
  DiagnosisActualFinding,
  DiagnosisAiSuggestion,
  DiagnosisInsight,
} from '../../src/types/datafix.ts';

export type GeminiDiagnosisErrorCode =
  | 'GEMINI_NOT_CONFIGURED'
  | 'GEMINI_AUTH_ERROR'
  | 'GEMINI_RATE_LIMIT'
  | 'GEMINI_MODEL_ERROR'
  | 'GEMINI_PARSE_ERROR'
  | 'GEMINI_UNAVAILABLE'
  | 'NO_ISSUES_TO_DIAGNOSE';

export class GeminiDiagnosisError extends Error {
  readonly code: GeminiDiagnosisErrorCode;
  readonly statusCode: number;
  readonly retryable: boolean;

  constructor(
    message: string,
    code: GeminiDiagnosisErrorCode,
    statusCode: number,
    retryable: boolean
  ) {
    super(message);
    this.name = 'GeminiDiagnosisError';
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

export interface RawGeminiDiagnosisItem {
  issueId: string;
  issueExplanation: string;
  possibleRootCause: string;
  recommendedRepair: string;
  recommendationReason: string;
  confidenceScore: number;
  requiresManualReview: boolean;
  suggestedValue?: string;
}

export type GenerateDiagnosisContentFn = (params: {
  model: string;
  contents: string;
  systemInstruction: string;
}) => Promise<string>;

export interface DiagnoseOptions {
  datasetId?: string;
  datasetName: string;
  columns?: string[];
  totalRows?: number;
  issues: readonly DetectedIssueRecord[];
  model?: string;
  maxIssuesPerBatch?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  /** Optional injectable generator for deterministic unit testing */
  generateContentFn?: GenerateDiagnosisContentFn;
  /** Optional injectable sleep function for fast retry testing */
  sleepFn?: (ms: number) => Promise<void>;
}

const PERSONAL_INFO_COLUMN_PATTERN =
  /(email|e_mail|mail|phone|mobile|tel|contact|full_?name|first_?name|last_?name|customer_?name|patient|person|address|street|ssn|sin|tax_?id|national_?id|passport|license|dob|birth|salary|wage|income|bank|iban|card)/i;

const SYSTEM_INSTRUCTION = `You are the DataFix AI Diagnosis Engine, a senior data quality reliability engineer.
You receive factual, deterministic data quality issues detected by the DataFix Detection Engine.
Your role is ADVISORY ONLY: you explain issues, infer likely root causes, and suggest careful repairs.

STRICT SAFETY & ACCURACY RULES:
1. NEVER invent, fabricate, or guess missing personal information (names, emails, phone numbers, addresses, IDs, dates of birth, salaries, or account details).
2. NEVER claim that you modified or fixed the dataset. Original records remain untouched.
3. For every issue, provide ALL FIVE required fields:
   - issueExplanation: Clear 1-2 sentence explanation of what makes this cell/row problematic.
   - possibleRootCause: Most plausible technical or human data-entry cause (e.g., for "amitgmail.com", "Missing '@' symbol between username and domain during manual entry or form copy-paste").
   - recommendedRepair: Actionable repair guidance. Suggest a specific correction ONLY when objective, high-confidence evidence exists directly in the value or dataset context (for example, normalizing "Bangalore" to "Bengaluru" or "12/01/2025" to "2025-01-12", or tentatively flagging a missing "@" in "amitgmail.com" for user confirmation). Whenever evidence is insufficient, ambiguous, or personal data is missing, explicitly recommend manual review.
   - recommendationReason: 1-2 sentences explaining why this repair or manual review is appropriate based on the available evidence.
   - confidenceScore: Realistic integer from 0 to 100 reflecting evidence strength (use <= 65 when manual review is required or evidence is ambiguous; 70-95 only when objective structural evidence supports the diagnosis).
4. Set requiresManualReview to true whenever:
   - A personal/identity field is missing or empty,
   - A value is impossible/ambiguous (e.g., impossible calendar date "2025-02-30", truncated phone "123", extreme unverified anomaly),
   - Or there is insufficient evidence to safely propose an exact replacement value.
5. Set suggestedValue to a proposed replacement string ONLY when requiresManualReview is false and objective evidence supports an exact value; otherwise return an empty string "".
6. Return strictly valid JSON matching the requested responseSchema, containing one entry per input issueId.`;

export function confidenceLevelFromScore(score: number): 'High' | 'Medium' | 'Low' {
  if (score >= 80) return 'High';
  if (score >= 55) return 'Medium';
  return 'Low';
}

function clampConfidenceScore(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return 50;
  // Handle models returning 0..1 floats defensively
  const normalized = num > 0 && num <= 1 ? num * 100 : num;
  return Math.max(0, Math.min(100, Math.round(normalized)));
}

function isPersonalInfoColumn(column: string): boolean {
  return PERSONAL_INFO_COLUMN_PATTERN.test(column);
}

/**
 * Enforces deterministic server-side safety guardrails on Gemini suggestions:
 * - Prevents inventing missing personal information.
 * - Ensures suggestedValue is null whenever manual review is required.
 */
export function enforceSafetyGuardrails(
  issue: DetectedIssueRecord,
  raw: RawGeminiDiagnosisItem,
  model: string,
  generatedAt: string
): DiagnosisAiSuggestion {
  let requiresManualReview = Boolean(raw.requiresManualReview);
  let confidenceScore = clampConfidenceScore(raw.confidenceScore);
  let recommendedRepair = (raw.recommendedRepair ?? '').trim();
  let recommendationReason = (raw.recommendationReason ?? '').trim();
  let suggestedValue =
    typeof raw.suggestedValue === 'string' && raw.suggestedValue.trim().length > 0
      ? raw.suggestedValue.trim()
      : null;

  // Hard guardrail: NEVER allow AI to invent missing personal information
  if (issue.issueType === 'Missing Values' && isPersonalInfoColumn(issue.column)) {
    requiresManualReview = true;
    suggestedValue = null;
    confidenceScore = Math.min(confidenceScore, 65);
    if (!/manual\s+review|source\s+system|verify/i.test(recommendedRepair)) {
      recommendedRepair = `Manual review required: obtain the missing "${issue.column}" value from the authoritative source system rather than inferring personal information.`;
    }
    if (!recommendationReason) {
      recommendationReason =
        'Missing personal or contact attributes cannot be reliably inferred without fabricating unverified information.';
    }
  }

  // Hard guardrail: never emit a replacement value if manual review is required
  if (requiresManualReview) {
    suggestedValue = null;
  }

  const issueExplanation =
    (raw.issueExplanation ?? '').trim() ||
    `${issue.issueType} detected in column "${issue.column}" at Row ${issue.rowNumber}.`;
  const possibleRootCause =
    (raw.possibleRootCause ?? '').trim() ||
    'Upstream data entry inconsistency or unvalidated source export.';

  if (!recommendedRepair) {
    recommendedRepair = requiresManualReview
      ? `Manual review recommended for Row ${issue.rowNumber} ("${issue.column}").`
      : issue.suggestedAction;
  }
  if (!recommendationReason) {
    recommendationReason = requiresManualReview
      ? 'Available evidence is insufficient for an automatic value replacement; analyst verification preserves record accuracy.'
      : 'Objective format or consistency evidence in the column supports this recommendation.';
  }

  return {
    issueExplanation,
    possibleRootCause,
    recommendedRepair,
    recommendationReason,
    confidenceScore,
    confidenceLevel: confidenceLevelFromScore(confidenceScore),
    requiresManualReview,
    suggestedValue,
    model,
    generatedAt,
  };
}

function classifyGeminiError(err: unknown): GeminiDiagnosisError {
  if (err instanceof GeminiDiagnosisError) return err;

  const errObj = err as {
    status?: number;
    statusCode?: number;
    code?: string | number;
    message?: string;
  };
  const message = errObj?.message || (err instanceof Error ? err.message : String(err));
  const status = Number(errObj?.status ?? errObj?.statusCode ?? 0);
  const upper = message.toUpperCase();

  if (upper.includes('GEMINI_API_KEY IS NOT CONFIGURED')) {
    return new GeminiDiagnosisError(
      'Gemini API key is not configured on the server. Check Settings > Secrets to attach a valid API key.',
      'GEMINI_NOT_CONFIGURED',
      503,
      false
    );
  }

  if (
    status === 403 ||
    status === 401 ||
    upper.includes('PERMISSION_DENIED') ||
    upper.includes('API_KEY_INVALID') ||
    upper.includes('API KEY NOT VALID')
  ) {
    return new GeminiDiagnosisError(
      'Gemini API authentication failed. Please check or update your API key in Settings > Secrets.',
      'GEMINI_AUTH_ERROR',
      502,
      false
    );
  }

  if (status === 429 || upper.includes('RESOURCE_EXHAUSTED') || upper.includes('RATE LIMIT')) {
    return new GeminiDiagnosisError(
      'Gemini API rate limit or quota reached. Please wait a moment and retry, or select a billing-enabled API key in Settings > Secrets.',
      'GEMINI_RATE_LIMIT',
      429,
      true
    );
  }

  if (status === 404 || upper.includes('NOT_FOUND') || upper.includes('IS NOT FOUND FOR API VERSION')) {
    return new GeminiDiagnosisError(
      `The configured Gemini diagnosis model (${DEFAULT_GEMINI_MODEL}) was not found. Please verify model availability.`,
      'GEMINI_MODEL_ERROR',
      502,
      false
    );
  }

  if (
    upper.includes('TIMEOUT') ||
    upper.includes('TIMED OUT') ||
    upper.includes('ABORT') ||
    upper.includes('DEADLINE_EXCEEDED') ||
    upper.includes('ETIMEDOUT')
  ) {
    return new GeminiDiagnosisError(
      'The Gemini AI diagnosis request timed out before returning a response. Your detected issues remain intact—please retry.',
      'GEMINI_UNAVAILABLE',
      504,
      false
    );
  }

  if (
    status >= 500 ||
    upper.includes('ECONNRESET') ||
    upper.includes('ENOTFOUND') ||
    upper.includes('FETCH FAILED') ||
    upper.includes('UNAVAILABLE')
  ) {
    return new GeminiDiagnosisError(
      'The Gemini AI service is temporarily unavailable. Your detected issues remain intact—please retry shortly.',
      'GEMINI_UNAVAILABLE',
      503,
      true
    );
  }

  return new GeminiDiagnosisError(
    `Gemini AI diagnosis request failed: ${message || 'Unexpected upstream error.'}`,
    'GEMINI_UNAVAILABLE',
    502,
    true
  );
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function callGeminiStructuredDiagnosis(params: {
  model: string;
  contents: string;
  systemInstruction: string;
}): Promise<string> {
  if (!isGeminiConfigured()) {
    throw new GeminiDiagnosisError(
      'Gemini API key is not configured on the server. Add a valid key in Settings > Secrets to run live AI diagnosis.',
      'GEMINI_NOT_CONFIGURED',
      503,
      false
    );
  }

  const ai = createGeminiClient();

  const thinkingLevel =
    params.model === 'gemini-3.1-flash-lite'
      ? ThinkingLevel.MINIMAL
      : ThinkingLevel.LOW;

  const response: GenerateContentResponse = await ai.models.generateContent({
    model: params.model,
    contents: params.contents,
    config: {
      abortSignal: AbortSignal.timeout(22000),
      thinkingConfig: { thinkingLevel },
      systemInstruction: params.systemInstruction,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          diagnoses: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                issueId: {
                  type: Type.STRING,
                  description: 'Exact issueId from the input detected issue.',
                },
                issueExplanation: {
                  type: Type.STRING,
                  description: 'Clear explanation of the detected data quality issue.',
                },
                possibleRootCause: {
                  type: Type.STRING,
                  description: 'Most likely upstream or data-entry root cause.',
                },
                recommendedRepair: {
                  type: Type.STRING,
                  description:
                    'Recommended repair action, or manual review if evidence is insufficient.',
                },
                recommendationReason: {
                  type: Type.STRING,
                  description:
                    'Reasoning explaining why the recommended repair or manual review is advised.',
                },
                confidenceScore: {
                  type: Type.NUMBER,
                  description: 'Confidence score integer from 0 to 100.',
                },
                requiresManualReview: {
                  type: Type.BOOLEAN,
                  description:
                    'True when insufficient evidence exists or personal data is missing.',
                },
                suggestedValue: {
                  type: Type.STRING,
                  description:
                    'Proposed value only when objective evidence exists and requiresManualReview is false; otherwise empty string.',
                },
              },
              required: [
                'issueId',
                'issueExplanation',
                'possibleRootCause',
                'recommendedRepair',
                'recommendationReason',
                'confidenceScore',
                'requiresManualReview',
                'suggestedValue',
              ],
            },
          },
        },
        required: ['diagnoses'],
      },
    },
  });

  return (response.text ?? '').trim();
}

function buildDiagnosisPrompt(
  datasetName: string,
  batch: readonly DetectedIssueRecord[],
  columns?: string[],
  totalRows?: number
): string {
  const payload = {
    datasetName,
    totalRows: totalRows ?? null,
    columns: columns ?? [],
    detectedIssues: batch.map((issue) => ({
      issueId: issue.id,
      issueType: issue.issueType,
      column: issue.column,
      rowNumber: issue.rowNumber,
      originalValue: issue.originalValue,
      severity: issue.severity,
      detectionDescription: issue.description,
      ruleEngineSuggestedAction: issue.suggestedAction,
    })),
  };

  return `Diagnose EVERY detected data quality issue in the following JSON payload from the DataFix Detection Engine.
Return one structured diagnosis object per issueId in the "diagnoses" array.
Remember: never invent missing personal data, recommend manual review when evidence is insufficient, and never claim original records were modified.

INPUT_DETECTED_ISSUES_JSON:
${JSON.stringify(payload)}`;
}

function parseGeminiJsonPayload(rawText: string): RawGeminiDiagnosisItem[] {
  const cleaned = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');

  if (!cleaned) {
    throw new GeminiDiagnosisError(
      'Gemini returned an empty diagnosis payload. Please retry.',
      'GEMINI_PARSE_ERROR',
      502,
      true
    );
  }

  try {
    const parsed = JSON.parse(cleaned) as
      | { diagnoses?: RawGeminiDiagnosisItem[] }
      | RawGeminiDiagnosisItem[];
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (parsed && Array.isArray(parsed.diagnoses)) {
      return parsed.diagnoses;
    }
    throw new Error('Missing diagnoses array in Gemini JSON output.');
  } catch (err) {
    if (err instanceof GeminiDiagnosisError) throw err;
    throw new GeminiDiagnosisError(
      'Received a malformed JSON response from Gemini AI. Please retry.',
      'GEMINI_PARSE_ERROR',
      502,
      true
    );
  }
}

async function runBatchWithRetries(
  fn: GenerateDiagnosisContentFn,
  params: { model: string; contents: string; systemInstruction: string },
  maxRetries: number,
  baseDelayMs: number,
  sleepFn: (ms: number) => Promise<void>
): Promise<RawGeminiDiagnosisItem[]> {
  let attempt = 0;
  let lastError: GeminiDiagnosisError | null = null;

  while (attempt <= maxRetries) {
    try {
      const rawText = await fn(params);
      return parseGeminiJsonPayload(rawText);
    } catch (err) {
      const errInfo = err as { name?: string; status?: number; code?: string; message?: string };
      console.error(
        `[DataFix Gemini] Attempt ${attempt + 1} failed:`,
        errInfo?.name || 'Error',
        errInfo?.status ?? errInfo?.code ?? '',
        (errInfo?.message || String(err)).slice(0, 240)
      );
      const classified = classifyGeminiError(err);
      lastError = classified;
      if (!classified.retryable || attempt >= maxRetries) {
        throw classified;
      }
      const delay = baseDelayMs * Math.pow(2, attempt);
      await sleepFn(delay);
      attempt += 1;
    }
  }

  throw (
    lastError ??
    new GeminiDiagnosisError(
      'Gemini AI diagnosis failed after retries.',
      'GEMINI_UNAVAILABLE',
      503,
      true
    )
  );
}

/**
 * Server-side AI Diagnosis Engine:
 * Receives row-level detected quality issues from the Detection Engine,
 * calls the Gemini API on the server in structured JSON mode, enforces
 * anti-PII-fabrication guardrails, and returns structured findings clearly
 * separating Actual Detection Engine Findings from Gemini AI Suggestions.
 *
 * Original dataset records and input issue objects are NEVER modified.
 */
export async function diagnoseDetectedIssues(
  options: DiagnoseOptions
): Promise<AiDiagnosisRunResult> {
  const {
    datasetId = 'standalone',
    datasetName,
    columns,
    totalRows,
    issues,
    model = DEFAULT_GEMINI_MODEL,
    maxIssuesPerBatch = 25,
    maxRetries = 1,
    baseDelayMs = 400,
    generateContentFn = callGeminiStructuredDiagnosis,
    sleepFn = defaultSleep,
  } = options;

  if (!Array.isArray(issues) || issues.length === 0) {
    throw new GeminiDiagnosisError(
      'No detected data quality issues found to diagnose for this dataset.',
      'NO_ISSUES_TO_DIAGNOSE',
      400,
      false
    );
  }

  // Work on shallow-cloned immutable snapshots so caller inputs are never mutated
  const immutableIssues: readonly DetectedIssueRecord[] = issues.map((item) =>
    Object.freeze({ ...item })
  );

  // Cap total issues analyzed in one interactive run to keep response latency strictly below HTTP proxy limits
  const boundedIssues = immutableIssues.slice(0, 50);
  const rawByIssueId = new Map<string, RawGeminiDiagnosisItem>();

  const batches: DetectedIssueRecord[][] = [];
  for (let offset = 0; offset < boundedIssues.length; offset += maxIssuesPerBatch) {
    batches.push(boundedIssues.slice(offset, offset + maxIssuesPerBatch));
  }

  const batchOutputs = await Promise.all(
    batches.map((batch) => {
      const prompt = buildDiagnosisPrompt(datasetName, batch, columns, totalRows);
      return runBatchWithRetries(
        generateContentFn,
        {
          model,
          contents: prompt,
          systemInstruction: SYSTEM_INSTRUCTION,
        },
        maxRetries,
        baseDelayMs,
        sleepFn
      );
    })
  );

  for (const batchResults of batchOutputs) {
    for (const item of batchResults) {
      if (item && typeof item.issueId === 'string' && item.issueId.trim()) {
        rawByIssueId.set(item.issueId.trim(), item);
      }
    }
  }

  const generatedAt = new Date().toISOString();
  const diagnoses: DiagnosisInsight[] = [];

  for (let i = 0; i < boundedIssues.length; i++) {
    const issue = boundedIssues[i];
    const matchedRaw = rawByIssueId.get(issue.id);
    if (!matchedRaw) {
      continue;
    }

    const actualFinding: DiagnosisActualFinding = {
      issueId: issue.id,
      issueType: issue.issueType,
      column: issue.column,
      rowNumber: issue.rowNumber,
      originalValue: issue.originalValue,
      severity: issue.severity,
      description: issue.description,
      engineSuggestedAction: issue.suggestedAction,
    };

    const aiSuggestion = enforceSafetyGuardrails(
      issue,
      matchedRaw,
      model,
      generatedAt
    );

    diagnoses.push({
      id: `diag-ai-${Date.now().toString(36)}-${i + 1}`,
      datasetId,
      datasetName,
      issueId: issue.id,
      column: issue.column,
      rootCause: aiSuggestion.possibleRootCause,
      businessImpact: aiSuggestion.issueExplanation,
      recommendedAction: aiSuggestion.recommendedRepair,
      confidenceLabel: aiSuggestion.confidenceLevel,
      confidenceScore: aiSuggestion.confidenceScore,
      source: 'Gemini AI',
      actualFinding,
      aiSuggestion,
    });
  }

  if (diagnoses.length === 0) {
    throw new GeminiDiagnosisError(
      'Gemini did not return structured diagnoses matching the detected issue IDs. Please retry.',
      'GEMINI_PARSE_ERROR',
      502,
      true
    );
  }

  const manualReviewCount = diagnoses.filter(
    (d) => d.aiSuggestion?.requiresManualReview
  ).length;

  return {
    datasetId,
    datasetName,
    model,
    generatedAt,
    originalRecordsModified: false,
    totalDetectedIssues: immutableIssues.length,
    diagnosedCount: diagnoses.length,
    manualReviewCount,
    diagnoses,
  };
}
