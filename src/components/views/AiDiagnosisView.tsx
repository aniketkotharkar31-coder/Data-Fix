import {
  AlertTriangle,
  ArrowRight,
  Check,
  Code2,
  Copy,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { datafixApi } from '../../services/api';
import type {
  AiDiagnosisRunResult,
  DatasetRecord,
  DetectedIssueRecord,
  DetectionIssueType,
  DiagnosisInsight,
  IssueSeverity,
  NavSectionId,
} from '../../types/datafix';

interface AiDiagnosisViewProps {
  datasets: DatasetRecord[];
  selectedDatasetId: string;
  onSelectDataset: (id: string) => void;
  detailedIssues: DetectedIssueRecord[];
  diagnoses: DiagnosisInsight[];
  onDiagnosesUpdated: (items: DiagnosisInsight[]) => Promise<void> | void;
  onNavigate: (section: NavSectionId) => void;
}

type ReviewFilter = 'All' | 'Actionable' | 'Manual Review';

const ISSUE_TYPE_OPTIONS: ('All' | DetectionIssueType)[] = [
  'All',
  'Missing Values',
  'Duplicate Records',
  'Invalid Formats',
  'Inconsistent Values',
  'Anomalies',
];

function severityTextClass(severity: IssueSeverity): string {
  switch (severity) {
    case 'Critical':
      return 'text-red-700';
    case 'Warning':
      return 'text-amber-700';
    case 'Info':
      return 'text-[#0284C7]';
  }
}

function issueTypeTextClass(type: DetectionIssueType): string {
  switch (type) {
    case 'Missing Values':
      return 'text-[#0B192C]';
    case 'Duplicate Records':
      return 'text-red-700';
    case 'Invalid Formats':
      return 'text-[#0284C7]';
    case 'Inconsistent Values':
      return 'text-[#A17816]';
    case 'Anomalies':
      return 'text-amber-700';
  }
}

function confidenceBarColor(score: number): string {
  if (score >= 80) return 'bg-[#0284C7]';
  if (score >= 55) return 'bg-[#C4962C]';
  return 'bg-amber-600';
}

function confidenceTextColor(score: number): string {
  if (score >= 80) return 'text-[#0284C7]';
  if (score >= 55) return 'text-[#A17816]';
  return 'text-amber-700';
}

export function AiDiagnosisView({
  datasets,
  selectedDatasetId,
  onSelectDataset,
  detailedIssues,
  diagnoses,
  onDiagnosesUpdated,
  onNavigate,
}: AiDiagnosisViewProps) {
  const effectiveDatasetId =
    selectedDatasetId && selectedDatasetId !== 'ALL'
      ? selectedDatasetId
      : datasets[0]?.id ?? '';

  const [running, setRunning] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastRunMeta, setLastRunMeta] = useState<AiDiagnosisRunResult | null>(null);
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>('All');
  const [issueTypeFilter, setIssueTypeFilter] = useState<'All' | DetectionIssueType>('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [showJsonOutput, setShowJsonOutput] = useState(false);
  const [copiedJson, setCopiedJson] = useState(false);

  const activeDataset = useMemo(
    () => datasets.find((ds) => ds.id === effectiveDatasetId) ?? null,
    [datasets, effectiveDatasetId]
  );

  // Actual row-level issues emitted by the Detection Engine for the selected dataset
  const datasetDetectedIssues = useMemo(
    () => detailedIssues.filter((item) => item.datasetId === effectiveDatasetId),
    [detailedIssues, effectiveDatasetId]
  );

  // Count detected issues per dataset for the dropdown selector
  const issueCountByDataset = useMemo(() => {
    const map = new Map<string, number>();
    for (const issue of detailedIssues) {
      map.set(issue.datasetId, (map.get(issue.datasetId) ?? 0) + 1);
    }
    return map;
  }, [detailedIssues]);

  // Separate live Gemini AI diagnoses (row-level) from seeded Baseline Profile notes
  const geminiDiagnoses = useMemo(
    () =>
      diagnoses.filter(
        (d) =>
          d.datasetId === effectiveDatasetId &&
          d.source === 'Gemini AI' &&
          Boolean(d.actualFinding && d.aiSuggestion)
      ),
    [diagnoses, effectiveDatasetId]
  );

  const baselineDiagnoses = useMemo(
    () =>
      diagnoses.filter(
        (d) => d.datasetId === effectiveDatasetId && d.source === 'Baseline Profile'
      ),
    [diagnoses, effectiveDatasetId]
  );

  const filteredGeminiDiagnoses = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return geminiDiagnoses.filter((item) => {
      const actual = item.actualFinding;
      const ai = item.aiSuggestion;
      if (!actual || !ai) return false;

      if (reviewFilter === 'Manual Review' && !ai.requiresManualReview) return false;
      if (reviewFilter === 'Actionable' && ai.requiresManualReview) return false;
      if (issueTypeFilter !== 'All' && actual.issueType !== issueTypeFilter) return false;

      if (q.length > 0) {
        return (
          actual.column.toLowerCase().includes(q) ||
          actual.originalValue.toLowerCase().includes(q) ||
          actual.issueType.toLowerCase().includes(q) ||
          `row ${actual.rowNumber}`.includes(q) ||
          ai.issueExplanation.toLowerCase().includes(q) ||
          ai.possibleRootCause.toLowerCase().includes(q) ||
          ai.recommendedRepair.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [geminiDiagnoses, reviewFilter, issueTypeFilter, searchQuery]);

  const manualReviewCount = useMemo(
    () => geminiDiagnoses.filter((d) => d.aiSuggestion?.requiresManualReview).length,
    [geminiDiagnoses]
  );

  const averageConfidence = useMemo(() => {
    if (geminiDiagnoses.length === 0) return null;
    const total = geminiDiagnoses.reduce(
      (sum, d) => sum + (d.aiSuggestion?.confidenceScore ?? 0),
      0
    );
    return Math.round(total / geminiDiagnoses.length);
  }, [geminiDiagnoses]);

  const structuredJsonPayload = useMemo(() => {
    if (geminiDiagnoses.length === 0) return null;
    return {
      datasetId: effectiveDatasetId,
      datasetName: activeDataset?.name ?? lastRunMeta?.datasetName ?? '',
      model:
        geminiDiagnoses[0]?.aiSuggestion?.model ??
        lastRunMeta?.model ??
        'gemini-3.1-flash-lite',
      generatedAt:
        geminiDiagnoses[0]?.aiSuggestion?.generatedAt ??
        lastRunMeta?.generatedAt ??
        '',
      originalRecordsModified: false,
      totalDetectedIssues: datasetDetectedIssues.length,
      diagnosedCount: geminiDiagnoses.length,
      manualReviewCount,
      diagnoses: geminiDiagnoses.map((item) => ({
        issueId: item.issueId,
        actualFinding: item.actualFinding,
        aiSuggestion: item.aiSuggestion,
      })),
    };
  }, [
    geminiDiagnoses,
    effectiveDatasetId,
    activeDataset,
    lastRunMeta,
    datasetDetectedIssues.length,
    manualReviewCount,
  ]);

  const handleRunDiagnosis = async () => {
    if (!effectiveDatasetId) return;
    setRunning(true);
    setErrorMessage(null);
    try {
      const response = await datafixApi.runGeminiDiagnosis(effectiveDatasetId);
      setLastRunMeta(response);
      await onDiagnosesUpdated(response.diagnoses);
    } catch (err) {
      console.error('[DataFix AI Diagnosis] Request failed:', err);
      setErrorMessage(
        err instanceof Error
          ? err.message
          : 'Unable to run Gemini AI diagnosis right now. Please retry.'
      );
    } finally {
      setRunning(false);
    }
  };

  const handleCopyJson = async () => {
    if (!structuredJsonPayload) return;
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(structuredJsonPayload, null, 2)
      );
      setCopiedJson(true);
      setTimeout(() => setCopiedJson(false), 2000);
    } catch {
      // Clipboard API may be unavailable in restricted contexts
    }
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[#0B192C]">
            AI Diagnosis
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Server-side Gemini API root-cause analysis and advisory repair recommendations mapped to each detected quality issue.
          </p>
        </div>

        <div className="flex flex-wrap sm:flex-nowrap items-center gap-2.5 shrink-0">
          <button
            type="button"
            disabled={running || !effectiveDatasetId || datasetDetectedIssues.length === 0}
            onClick={handleRunDiagnosis}
            data-testid="run-ai-diagnosis-btn"
            className="inline-flex items-center gap-2 rounded-md bg-[#0284C7] px-4 py-2 text-sm font-medium text-white hover:bg-[#0369A1] disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            {running ? (
              <RefreshCw className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            <span>
              {running
                ? 'Analyzing with Gemini...'
                : geminiDiagnoses.length > 0
                  ? 'Re-run AI Diagnosis'
                  : 'Run AI Diagnosis'}
            </span>
          </button>
          <button
            type="button"
            onClick={() => onNavigate('repair')}
            className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-[#0B192C] hover:bg-slate-50 whitespace-nowrap shrink-0"
          >
            <span>Review Repair Plan</span>
            <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Dataset Selector & KPI Strip */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="lg:col-span-5 rounded-lg border border-slate-200 bg-white p-4">
          <label
            htmlFor="diagnosis-dataset-select"
            className="block text-xs font-medium text-slate-500"
          >
            Target Dataset
          </label>
          <select
            id="diagnosis-dataset-select"
            value={effectiveDatasetId}
            onChange={(e) => {
              onSelectDataset(e.target.value);
              setErrorMessage(null);
            }}
            className="mt-1.5 w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium text-[#0B192C] focus:border-[#0284C7] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0284C7]/20"
          >
            {datasets.map((ds) => (
              <option key={ds.id} value={ds.id}>
                {ds.name} ({issueCountByDataset.get(ds.id) ?? 0} detected issues)
              </option>
            ))}
          </select>
        </div>

        <div className="lg:col-span-2 rounded-lg border border-slate-200 bg-white p-4">
          <p className="text-xs font-medium text-slate-500">Detected Issues</p>
          <p
            className="mt-1.5 font-mono text-2xl font-semibold tabular-nums text-[#0B192C]"
            data-testid="diagnosis-detected-count"
          >
            {datasetDetectedIssues.length.toLocaleString()}
          </p>
        </div>

        <div className="lg:col-span-3 rounded-lg border border-slate-200 bg-white p-4">
          <p className="text-xs font-medium text-slate-500">AI Diagnosed</p>
          <p
            className="mt-1.5 font-mono text-2xl font-semibold tabular-nums text-[#0284C7]"
            data-testid="diagnosis-generated-count"
          >
            {geminiDiagnoses.length.toLocaleString()}
            {geminiDiagnoses.length > 0 && (
              <span className="ml-2 font-sans text-xs font-semibold text-amber-700">
                {manualReviewCount} manual review
              </span>
            )}
          </p>
        </div>

        <div className="lg:col-span-2 rounded-lg border border-[#D9B352]/60 bg-white p-4">
          <p className="text-xs font-medium text-slate-500">Avg. Confidence</p>
          <p
            className="mt-1.5 font-mono text-2xl font-semibold tabular-nums text-[#0B192C]"
            data-testid="diagnosis-avg-confidence"
          >
            {averageConfidence !== null ? `${averageConfidence}%` : '—'}
          </p>
        </div>
      </div>

      {/* Advisory Read-Only Safeguard & JSON Output Toggle */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between rounded-lg border border-slate-200 bg-white px-4 py-3">
        <div className="flex items-start sm:items-center gap-2.5 text-xs text-slate-600">
          <ShieldCheck
            aria-hidden="true"
            className="h-4 w-4 text-[#0284C7] shrink-0 mt-0.5 sm:mt-0"
          />
          <p>
            <span className="font-semibold text-[#0B192C]">Read-Only Advisory Mode:</span>{' '}
            Actual findings come directly from the Detection Engine. Gemini AI suggestions never modify original records automatically and never fabricate missing personal data.
          </p>
        </div>

        {structuredJsonPayload && (
          <button
            type="button"
            onClick={() => setShowJsonOutput((prev) => !prev)}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-[#0B192C] hover:bg-slate-100 whitespace-nowrap shrink-0 self-start sm:self-auto"
          >
            <Code2 className="h-3.5 w-3.5 text-[#0284C7]" />
            <span>{showJsonOutput ? 'Hide Structured JSON' : 'View Structured JSON'}</span>
          </button>
        )}
      </div>

      {/* Loading Indicator during Gemini API Execution */}
      {running && (
        <div
          role="status"
          aria-live="polite"
          aria-busy="true"
          data-testid="ai-diagnosis-loading"
          className="flex items-center gap-3 rounded-lg border border-[#0284C7]/35 bg-[#EBF5FC] px-4 py-3.5 text-sm text-[#0B192C]"
        >
          <Loader2 className="h-4 w-4 animate-spin text-[#0284C7] shrink-0" aria-hidden="true" />
          <div>
            <p className="font-semibold text-[#0B192C]">
              Running Server-Side Gemini AI Diagnosis
            </p>
            <p className="text-xs text-slate-600">
              Analyzing {datasetDetectedIssues.length} detected{' '}
              {datasetDetectedIssues.length === 1 ? 'issue' : 'issues'} in{' '}
              <span className="font-mono text-[#0B192C]">{activeDataset?.name}</span>{' '}
              without modifying original dataset records...
            </p>
          </div>
        </div>
      )}

      {/* Graceful Error Banner */}
      {errorMessage && (
        <div
          role="alert"
          data-testid="diagnosis-error-banner"
          className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between rounded-lg border border-red-200 bg-red-50 px-4 py-3.5 text-sm text-red-900"
        >
          <div className="flex items-start gap-2.5 min-w-0">
            <AlertTriangle
              aria-hidden="true"
              className="h-4 w-4 text-red-600 shrink-0 mt-0.5"
            />
            <div className="min-w-0">
              <p className="font-semibold text-red-900">AI Diagnosis Request Failed</p>
              <p className="mt-0.5 text-xs text-red-800 break-words">{errorMessage}</p>
            </div>
          </div>
          <button
            type="button"
            disabled={running}
            onClick={handleRunDiagnosis}
            className="inline-flex items-center gap-1.5 rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-800 hover:bg-red-50 whitespace-nowrap shrink-0 self-start sm:self-auto"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>Retry Diagnosis</span>
          </button>
        </div>
      )}

      {/* Optional Structured JSON Inspector */}
      {showJsonOutput && structuredJsonPayload && (
        <section
          aria-label="Structured Gemini JSON response"
          className="rounded-lg border border-slate-200 bg-[#0B192C] text-slate-100 overflow-hidden"
        >
          <div className="flex items-center justify-between border-b border-slate-700/80 px-4 py-2.5">
            <p className="font-mono text-xs text-slate-300">
              Structured JSON Output · {structuredJsonPayload.diagnosedCount} diagnosed issues
            </p>
            <button
              type="button"
              onClick={handleCopyJson}
              className="inline-flex items-center gap-1.5 rounded border border-slate-600 bg-slate-800 px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-slate-700"
            >
              {copiedJson ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                  <span>Copied</span>
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  <span>Copy JSON</span>
                </>
              )}
            </button>
          </div>
          <pre className="max-h-72 overflow-auto p-4 font-mono text-xs leading-relaxed text-sky-100">
            {JSON.stringify(structuredJsonPayload, null, 2)}
          </pre>
        </section>
      )}

      {/* Main Content Area */}
      {geminiDiagnoses.length > 0 ? (
        <section aria-label="Gemini AI diagnosis findings" className="space-y-4">
          {/* Filter Bar */}
          <div className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-[#0B192C]">
                Issue-by-Issue Gemini AI Diagnosis
              </h2>
              <p className="text-xs text-slate-500">
                Showing {filteredGeminiDiagnoses.length} of {geminiDiagnoses.length} diagnosed issues for{' '}
                <span className="font-mono text-[#0B192C]">{activeDataset?.name}</span>
              </p>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap xl:flex-nowrap sm:items-center shrink-0">
              <div className="relative">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
                />
                <label htmlFor="diagnosis-search" className="sr-only">
                  Search AI diagnoses
                </label>
                <input
                  id="diagnosis-search"
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search column, row, or cause..."
                  className="w-full sm:w-48 rounded-md border border-slate-200 bg-slate-50 py-1.5 pl-8 pr-3 text-xs text-[#0B192C] placeholder:text-slate-400 focus:border-[#0284C7] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0284C7]/20"
                />
              </div>

              <label htmlFor="diagnosis-type-filter" className="sr-only">
                Filter diagnoses by issue type
              </label>
              <select
                id="diagnosis-type-filter"
                value={issueTypeFilter}
                onChange={(e) =>
                  setIssueTypeFilter(e.target.value as 'All' | DetectionIssueType)
                }
                className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-medium text-[#0B192C] focus:border-[#0284C7] focus:bg-white focus:outline-none"
              >
                {ISSUE_TYPE_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt === 'All' ? 'All Issue Types' : opt}
                  </option>
                ))}
              </select>

              <div
                role="group"
                aria-label="Filter diagnoses by review type"
                className="flex items-center gap-1 rounded-md bg-slate-100 p-1 self-start sm:self-auto"
              >
                {(['All', 'Actionable', 'Manual Review'] as ReviewFilter[]).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setReviewFilter(mode)}
                    className={`rounded px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors ${
                      reviewFilter === mode
                        ? 'bg-white text-[#0B192C] shadow-xs'
                        : 'text-slate-600 hover:text-[#0B192C]'
                    }`}
                  >
                    {mode}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Two-Zone Cards: Actual Finding vs. Gemini AI Suggestion */}
          {filteredGeminiDiagnoses.length === 0 ? (
            <div className="rounded-lg border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
              No diagnosed issues match the current filter criteria.
            </div>
          ) : (
            <div className="space-y-4" data-testid="ai-diagnosis-cards">
              {filteredGeminiDiagnoses.map((item) => {
                const actual = item.actualFinding!;
                const ai = item.aiSuggestion!;
                const isEmptyVal = actual.originalValue === '(empty)';

                return (
                  <article
                    key={item.id}
                    data-testid="ai-diagnosis-card"
                    className="rounded-lg border border-slate-200 bg-white overflow-hidden"
                  >
                    {/* ZONE 1: ACTUAL FINDING (Detection Engine) */}
                    <div className="border-b border-slate-200 bg-[#F8FAFC] px-5 py-3.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
                          <span className="font-semibold uppercase tracking-wide text-[11px] text-slate-500">
                            Actual Finding · Detection Engine
                          </span>
                          <span aria-hidden="true" className="text-slate-300">
                            |
                          </span>
                          <span className={`font-semibold ${issueTypeTextClass(actual.issueType)}`}>
                            {actual.issueType}
                          </span>
                          <span aria-hidden="true" className="text-slate-300">
                            ·
                          </span>
                          <span className="font-mono font-semibold text-[#0B192C]">
                            {actual.column}
                          </span>
                          <span aria-hidden="true" className="text-slate-300">
                            ·
                          </span>
                          <span className="font-mono tabular-nums font-semibold text-[#0B192C]">
                            Row {actual.rowNumber}
                          </span>
                        </div>

                        <span className={`text-xs font-semibold ${severityTextClass(actual.severity)}`}>
                          {actual.severity} Severity
                        </span>
                      </div>

                      <div className="mt-2.5 grid grid-cols-1 gap-3 md:grid-cols-12 text-xs">
                        <div className="md:col-span-4">
                          <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
                            Original Value (Unmodified)
                          </span>
                          <p
                            className={`mt-0.5 font-mono break-words ${
                              isEmptyVal ? 'italic text-amber-700' : 'font-semibold text-[#0B192C]'
                            }`}
                          >
                            {actual.originalValue}
                          </p>
                        </div>
                        <div className="md:col-span-8">
                          <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
                            Detection Engine Rule Finding
                          </span>
                          <p className="mt-0.5 text-slate-700 leading-relaxed">
                            {actual.description}
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* ZONE 2: AI SUGGESTION (Gemini API — Advisory Only) */}
                    <div className="px-5 py-4 bg-white">
                      <div className="flex flex-wrap items-center justify-between gap-2.5 pb-3 border-b border-slate-100">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                          <span className="inline-flex items-center gap-1.5">
                            <Sparkles aria-hidden="true" className="h-3.5 w-3.5 text-[#0284C7] shrink-0" />
                            <span className="font-semibold uppercase tracking-wide text-[11px] text-[#0284C7]">
                              AI Suggestion · Gemini Advisory
                            </span>
                          </span>
                          <span aria-hidden="true" className="hidden sm:inline text-slate-300">
                            ·
                          </span>
                          <span
                            className={
                              ai.requiresManualReview
                                ? 'font-semibold text-amber-700'
                                : 'font-medium text-slate-600'
                            }
                          >
                            {ai.requiresManualReview
                              ? 'Manual Review Recommended'
                              : 'Evidence-Backed Suggestion (Not Auto-Applied)'}
                          </span>
                        </div>

                        {/* Confidence Score Meter */}
                        <div className="flex items-center gap-2.5">
                          <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                            Confidence Score
                          </span>
                          <div className="w-20 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                            <div
                              className={`h-full ${confidenceBarColor(ai.confidenceScore)}`}
                              style={{ width: `${ai.confidenceScore}%` }}
                            />
                          </div>
                          <span
                            className={`font-mono text-xs font-semibold tabular-nums ${confidenceTextColor(
                              ai.confidenceScore
                            )}`}
                          >
                            {ai.confidenceScore}% ({ai.confidenceLevel})
                          </span>
                        </div>
                      </div>

                      {/* All 4 textual Gemini fields in a balanced 2x2 grid */}
                      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 text-sm">
                        <div>
                          <p className="text-xs font-semibold text-slate-500">
                            1. Issue Explanation
                          </p>
                          <p className="mt-1 text-slate-700 leading-relaxed">
                            {ai.issueExplanation}
                          </p>
                        </div>

                        <div>
                          <p className="text-xs font-semibold text-slate-500">
                            2. Possible Root Cause
                          </p>
                          <p className="mt-1 text-slate-700 leading-relaxed">
                            {ai.possibleRootCause}
                          </p>
                        </div>

                        <div>
                          <p className="text-xs font-semibold text-slate-500">
                            3. Recommended Repair
                          </p>
                          <p className="mt-1 font-medium text-[#0B192C] leading-relaxed">
                            {ai.recommendedRepair}
                          </p>
                          {ai.suggestedValue && !ai.requiresManualReview && (
                            <p className="mt-1.5 text-xs text-slate-600">
                              Proposed value (pending confirmation):{' '}
                              <span className="font-mono font-semibold text-[#0284C7]">
                                {ai.suggestedValue}
                              </span>
                            </p>
                          )}
                          {ai.requiresManualReview && (
                            <p className="mt-1.5 text-xs font-medium text-amber-700">
                              Insufficient objective evidence or sensitive field — verify manually before editing.
                            </p>
                          )}
                        </div>

                        <div>
                          <p className="text-xs font-semibold text-slate-500">
                            4. Reason for Recommendation
                          </p>
                          <p className="mt-1 text-slate-700 leading-relaxed">
                            {ai.recommendationReason}
                          </p>
                        </div>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      ) : (
        /* Pre-Run View: Show Actual Detection Engine Findings Queued for Gemini */
        <section
          aria-label="Detected issues ready for Gemini AI diagnosis"
          className="rounded-lg border border-slate-200 bg-white overflow-hidden"
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-slate-200 px-5 py-4">
            <div>
              <h2 className="text-base font-semibold text-[#0B192C]">
                Detected Issues Ready for Gemini AI Diagnosis
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                {datasetDetectedIssues.length > 0
                  ? `${datasetDetectedIssues.length} actual findings from the Detection Engine in ${activeDataset?.name ?? 'selected dataset'}. Run AI Diagnosis to generate explanations, root causes, repair guidance, and confidence scores.`
                  : 'No open data quality issues detected in this dataset.'}
              </p>
            </div>
            {datasetDetectedIssues.length > 0 && (
              <button
                type="button"
                disabled={running}
                onClick={handleRunDiagnosis}
                className="inline-flex items-center gap-2 rounded-md bg-[#0B192C] px-4 py-2 text-xs font-medium text-white hover:bg-[#163155] disabled:opacity-50 whitespace-nowrap shrink-0 self-start sm:self-auto"
              >
                <Sparkles className="h-3.5 w-3.5 text-[#38BDF8]" />
                <span>
                  {running ? 'Running Gemini Analysis...' : 'Diagnose All Detected Issues'}
                </span>
              </button>
            )}
          </div>

          {datasetDetectedIssues.length === 0 ? (
            <div className="p-10 text-center">
              <p className="text-sm font-medium text-[#0B192C]">
                This dataset has no flagged issues to diagnose.
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Upload a dataset with quality anomalies or select another dataset above.
              </p>
            </div>
          ) : (
            <div className="w-full overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    <th className="py-2.5 pl-5 pr-3">Issue Type</th>
                    <th className="px-3 py-2.5">Column</th>
                    <th className="px-3 py-2.5 text-right">Row</th>
                    <th className="px-3 py-2.5">Original Value</th>
                    <th className="px-3 py-2.5">Detection Finding</th>
                    <th className="py-2.5 pl-3 pr-5">Severity</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {datasetDetectedIssues.slice(0, 15).map((issue) => (
                    <tr key={issue.id} className="hover:bg-[#EBF5FC]/35">
                      <td className="py-2.5 pl-5 pr-3 whitespace-nowrap">
                        <span className={`font-semibold ${issueTypeTextClass(issue.issueType)}`}>
                          {issue.issueType}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 font-mono font-semibold text-[#0B192C] whitespace-nowrap">
                        {issue.column}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono tabular-nums font-semibold text-[#0B192C] whitespace-nowrap">
                        Row {issue.rowNumber}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-slate-700 max-w-[160px] break-words">
                        {issue.originalValue}
                      </td>
                      <td className="px-3 py-2.5 text-slate-600">{issue.description}</td>
                      <td className="py-2.5 pl-3 pr-5 whitespace-nowrap">
                        <span className={`font-semibold ${severityTextClass(issue.severity)}`}>
                          {issue.severity}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {datasetDetectedIssues.length > 15 && (
                <div className="border-t border-slate-100 bg-slate-50/50 px-5 py-2.5 text-xs text-slate-500">
                  Showing first 15 of {datasetDetectedIssues.length} detected issues queued for Gemini diagnosis.
                </div>
              )}
            </div>
          )}

          {/* Optional Seeded Baseline Reference Notes (Clearly Labeled) */}
          {baselineDiagnoses.length > 0 && (
            <div className="border-t border-slate-200 bg-slate-50/60 px-5 py-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Sample Baseline Profile Notes (Pre-Gemini Demo Reference)
              </p>
              <div className="mt-2.5 grid grid-cols-1 gap-3 md:grid-cols-2">
                {baselineDiagnoses.map((note) => (
                  <div
                    key={note.id}
                    className="rounded-md border border-slate-200 bg-white p-3.5 text-xs"
                  >
                    <p className="font-mono font-semibold text-[#0B192C]">
                      Column: {note.column}
                    </p>
                    <p className="mt-1 text-slate-600 leading-relaxed">{note.rootCause}</p>
                    <p className="mt-1.5 font-medium text-[#0B192C]">
                      {note.recommendedAction}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
