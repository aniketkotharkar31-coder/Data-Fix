import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Download,
  Loader2,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { datafixApi } from '../../services/api';
import { downloadFileFromApi } from '../../utils/downloadFile';
import type {
  DatasetRecord,
  NavSectionId,
  ValidationCheck,
  ValidationComparisonReport,
  ValidationReportStatus,
} from '../../types/datafix';

interface ValidationViewProps {
  datasets: DatasetRecord[];
  selectedDatasetId: string;
  onSelectDataset: (id: string) => void;
  validations: ValidationCheck[];
  validationReports: ValidationComparisonReport[];
  onValidationComplete: () => Promise<void> | void;
  onNavigate?: (section: NavSectionId) => void;
}

type OutcomeFilter = 'All' | 'Confirmed' | 'Failed';

function statusTextClass(status: ValidationReportStatus): string {
  switch (status) {
    case 'Validated':
    case 'Validated (Clean Baseline)':
      return 'text-emerald-700';
    case 'Partially Validated':
      return 'text-[#0284C7]';
    case 'Validation Warning':
      return 'text-red-700';
    case 'Pending Repair':
      return 'text-amber-700';
  }
}

function formatCellValue(value: string): string {
  if (value !== value.trim()) {
    return `"${value}"`;
  }
  return value;
}

export function ValidationView({
  datasets,
  selectedDatasetId,
  onSelectDataset,
  validations,
  validationReports,
  onValidationComplete,
  onNavigate,
}: ValidationViewProps) {
  const effectiveDatasetId =
    selectedDatasetId && selectedDatasetId !== 'ALL'
      ? selectedDatasetId
      : datasets[0]?.id ?? '';

  const activeDataset = useMemo(
    () => datasets.find((d) => d.id === effectiveDatasetId) ?? null,
    [datasets, effectiveDatasetId]
  );

  const activeReport = useMemo(
    () =>
      validationReports.find((r) => r.datasetId === effectiveDatasetId) ?? null,
    [validationReports, effectiveDatasetId]
  );

  const datasetValidations = useMemo(() => {
    if (activeReport?.checks) return activeReport.checks;
    return validations.filter((v) => v.datasetId === effectiveDatasetId);
  }, [activeReport, validations, effectiveDatasetId]);

  const [validating, setValidating] = useState(false);
  const [downloadingKey, setDownloadingKey] = useState<
    'csv' | 'xlsx' | 'quality-report' | 'modifications' | null
  >(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [outcomeFilter, setOutcomeFilter] = useState<OutcomeFilter>('All');

  const dimensionChartData = useMemo(
    () =>
      datasetValidations.map((check) => ({
        dimension: check.dimension,
        before: check.beforeScore,
        after: check.afterScore,
      })),
    [datasetValidations]
  );

  const issueComparisonChartData = useMemo(() => {
    if (!activeReport) return [];
    return [
      {
        metric: 'Missing Values',
        original: activeReport.originalMissingValues,
        remaining: activeReport.remainingMissingValues,
      },
      {
        metric: 'Duplicate Records',
        original: activeReport.originalDuplicateRecords,
        remaining: activeReport.remainingDuplicateRecords,
      },
      {
        metric: 'Invalid Entries',
        original: activeReport.originalInvalidEntries,
        remaining: activeReport.remainingInvalidEntries,
      },
    ];
  }, [activeReport]);

  const filteredOutcomes = useMemo(() => {
    const list = activeReport?.repairOutcomes ?? [];
    if (outcomeFilter === 'All') return list;
    return list.filter((item) => item.status === outcomeFilter);
  }, [activeReport, outcomeFilter]);

  const passedGateCount = datasetValidations.filter((c) => c.passed).length;

  const handleRunValidationGate = async () => {
    if (!effectiveDatasetId) return;
    setValidating(true);
    setNotice(null);
    setErrorMessage(null);
    try {
      const result = await datafixApi.validateDataset(effectiveDatasetId);
      const rpt = result.report;
      const sign = rpt.qualityScoreImprovement >= 0 ? '+' : '';
      setNotice(
        result.allPassed
          ? `Validation confirmed for ${result.dataset.name}: ${rpt.issuesSuccessfullyRepaired} repairs confirmed, 0 failed, quality score ${rpt.originalQualityScore.toFixed(1)}% -> ${rpt.updatedQualityScore.toFixed(1)}% (${sign}${rpt.qualityScoreImprovement.toFixed(1)}%). A validation certificate has been added to Reports.`
          : `Re-analyzed ${result.dataset.name}: ${rpt.issuesSuccessfullyRepaired} repairs confirmed, ${rpt.remainingIssues} remaining issues, ${rpt.failedRepairs} failed repairs (quality score ${rpt.updatedQualityScore.toFixed(1)}%).`
      );
      await onValidationComplete();
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Unable to execute validation engine.'
      );
    } finally {
      setValidating(false);
    }
  };

  const handleDownloadExport = async (format: 'csv' | 'xlsx') => {
    if (!activeDataset) return;
    setDownloadingKey(format);
    setErrorMessage(null);
    try {
      const url = datafixApi.getExportUrl(activeDataset.id, format);
      const fallback = `${activeDataset.name.replace(/\.(csv|xlsx|xls)$/i, '')}_cleaned.${format}`;
      const { filename } = await downloadFileFromApi(url, fallback);
      setNotice(`Exported cleaned ${format.toUpperCase()} dataset "${filename}".`);
      await onValidationComplete();
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : `Unable to download cleaned ${format.toUpperCase()} dataset.`
      );
    } finally {
      setDownloadingKey(null);
    }
  };

  const handleDownloadReportDeliverable = async (
    kind: 'quality-report' | 'modifications'
  ) => {
    if (!activeDataset) return;
    setDownloadingKey(kind);
    setErrorMessage(null);
    try {
      const baseName = activeDataset.name.replace(/\.(csv|xlsx|xls)$/i, '');
      const url =
        kind === 'quality-report'
          ? datafixApi.getQualityReportExportUrl(activeDataset.id, 'xlsx')
          : datafixApi.getDatasetModificationsExportUrl(activeDataset.id, 'xlsx');
      const fallback =
        kind === 'quality-report'
          ? `${baseName}_quality_report.xlsx`
          : `${baseName}_modification_history.xlsx`;
      const { filename } = await downloadFileFromApi(url, fallback);
      setNotice(`Downloaded "${filename}" successfully.`);
      await onValidationComplete();
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Unable to download validated deliverable.'
      );
    } finally {
      setDownloadingKey(null);
    }
  };

  const scoreImprovement = activeReport?.qualityScoreImprovement ?? 0;
  const scoreImprovementFormatted = `${scoreImprovement > 0 ? '+' : ''}${scoreImprovement.toFixed(1)}%`;

  const comparisonRows = useMemo(() => {
    if (!activeReport) return [];
    const missingDelta =
      activeReport.remainingMissingValues - activeReport.originalMissingValues;
    const dupDelta =
      activeReport.remainingDuplicateRecords -
      activeReport.originalDuplicateRecords;
    const invalidDelta =
      activeReport.remainingInvalidEntries -
      activeReport.originalInvalidEntries;
    const scoreDelta = activeReport.qualityScoreImprovement;

    return [
      {
        testId: 'val-metric-missing',
        label: 'Missing Values',
        sublabel: 'Original missing values vs. remaining missing values',
        beforeDisplay: activeReport.originalMissingValues.toLocaleString(),
        afterDisplay: activeReport.remainingMissingValues.toLocaleString(),
        deltaDisplay:
          missingDelta < 0
            ? `${missingDelta} resolved`
            : missingDelta === 0
              ? 'No change'
              : `+${missingDelta} added`,
        improved: missingDelta < 0,
        degraded: missingDelta > 0,
      },
      {
        testId: 'val-metric-duplicates',
        label: 'Duplicate Records',
        sublabel: 'Original duplicate records vs. remaining duplicate records',
        beforeDisplay: activeReport.originalDuplicateRecords.toLocaleString(),
        afterDisplay: activeReport.remainingDuplicateRecords.toLocaleString(),
        deltaDisplay:
          dupDelta < 0
            ? `${dupDelta} removed`
            : dupDelta === 0
              ? 'No change'
              : `+${dupDelta} added`,
        improved: dupDelta < 0,
        degraded: dupDelta > 0,
      },
      {
        testId: 'val-metric-invalid',
        label: 'Invalid Entries',
        sublabel:
          'Invalid formats, inconsistent values & anomalies (original vs. remaining)',
        beforeDisplay: activeReport.originalInvalidEntries.toLocaleString(),
        afterDisplay: activeReport.remainingInvalidEntries.toLocaleString(),
        deltaDisplay:
          invalidDelta < 0
            ? `${invalidDelta} resolved`
            : invalidDelta === 0
              ? 'No change'
              : `+${invalidDelta} added`,
        improved: invalidDelta < 0,
        degraded: invalidDelta > 0,
      },
      {
        testId: 'val-metric-score',
        label: 'Data Quality Score',
        sublabel: 'Original quality score vs. updated post-repair quality score',
        beforeDisplay: `${activeReport.originalQualityScore.toFixed(1)}%`,
        afterDisplay: `${activeReport.updatedQualityScore.toFixed(1)}%`,
        deltaDisplay:
          scoreDelta > 0
            ? `+${scoreDelta.toFixed(1)}% lift`
            : scoreDelta < 0
              ? `${scoreDelta.toFixed(1)}% drop`
              : '0.0% change',
        improved: scoreDelta > 0,
        degraded: scoreDelta < 0,
      },
    ];
  }, [activeReport]);

  return (
    <div className="space-y-6">
      {/* Page Header & Actions */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[#0B192C]">
            Validation
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Re-analyze repaired datasets against the preserved original baseline. Repairs are reported as successful only after validation confirms them.
          </p>
        </div>

        <div className="flex flex-wrap sm:flex-nowrap items-center gap-2 shrink-0">
          <button
            type="button"
            disabled={validating || !activeDataset}
            onClick={handleRunValidationGate}
            data-testid="run-validation-btn"
            className="inline-flex items-center gap-2 rounded-md bg-[#0284C7] px-4 py-2 text-sm font-medium text-white hover:bg-[#0369A1] disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <RefreshCw
              className={`h-4 w-4 ${validating ? 'animate-spin' : ''}`}
            />
            <span>{validating ? 'Re-Analyzing...' : 'Re-Analyze & Validate'}</span>
          </button>

          <button
            type="button"
            onClick={() => void handleDownloadExport('csv')}
            disabled={!activeDataset || downloadingKey !== null}
            className="inline-flex items-center gap-2 rounded-md bg-[#0B192C] px-3.5 py-2 text-sm font-medium text-white hover:bg-[#163155] disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            {downloadingKey === 'csv' ? (
              <Loader2 className="h-4 w-4 animate-spin text-[#D9B352]" />
            ) : (
              <Download className="h-4 w-4 text-[#D9B352]" />
            )}
            <span>{downloadingKey === 'csv' ? 'Exporting...' : 'Download CSV'}</span>
          </button>

          <button
            type="button"
            onClick={() => void handleDownloadExport('xlsx')}
            disabled={!activeDataset || downloadingKey !== null}
            className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-[#0B192C] hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            {downloadingKey === 'xlsx' ? (
              <Loader2 className="h-4 w-4 animate-spin text-[#0284C7]" />
            ) : (
              <Download className="h-4 w-4 text-[#0284C7]" />
            )}
            <span>
              {downloadingKey === 'xlsx' ? 'Exporting...' : 'Download Excel'}
            </span>
          </button>
        </div>
      </div>

      {/* Dataset Selector & Validation Provenance Bar */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="lg:col-span-5 rounded-lg border border-slate-200 bg-white p-4">
          <label
            htmlFor="validation-dataset-select"
            className="block text-xs font-medium text-slate-500"
          >
            Target Dataset
          </label>
          <select
            id="validation-dataset-select"
            value={effectiveDatasetId}
            onChange={(e) => {
              onSelectDataset(e.target.value);
              setNotice(null);
              setErrorMessage(null);
              setOutcomeFilter('All');
            }}
            className="mt-1.5 w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium text-[#0B192C] focus:border-[#0284C7] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0284C7]/20"
          >
            {datasets.map((ds) => (
              <option key={ds.id} value={ds.id}>
                {ds.name} ({ds.status})
              </option>
            ))}
          </select>
        </div>

        <div className="lg:col-span-7 rounded-lg border border-slate-200 bg-white p-4 flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
          <div className="space-y-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <ShieldCheck
                aria-hidden="true"
                className="h-4 w-4 text-[#0284C7] shrink-0"
              />
              <span className="font-semibold text-[#0B192C]">
                Validation Status:
              </span>
              <span
                data-testid="validation-status-label"
                className={`font-semibold ${
                  activeReport
                    ? statusTextClass(activeReport.validationStatus)
                    : 'text-slate-600'
                }`}
              >
                {activeReport?.validationStatus ?? activeDataset?.status ?? '—'}
              </span>
            </div>
            <p className="text-xs text-slate-600">
              {activeReport ? (
                <>
                  Records verified:{' '}
                  <span className="font-mono font-semibold tabular-nums text-[#0B192C]">
                    {activeReport.originalRowCount.toLocaleString()}
                  </span>{' '}
                  original →{' '}
                  <span className="font-mono font-semibold tabular-nums text-[#0B192C]">
                    {activeReport.currentRowCount.toLocaleString()}
                  </span>{' '}
                  current · Gates passed:{' '}
                  <span className="font-mono font-semibold tabular-nums text-[#0B192C]">
                    {passedGateCount}/{datasetValidations.length}
                  </span>{' '}
                  · Last validated{' '}
                  <span className="font-mono tabular-nums text-slate-700">
                    {activeReport.validatedAt}
                  </span>
                </>
              ) : (
                'Select a dataset to view before-and-after validation comparisons.'
              )}
            </p>
          </div>

          {onNavigate && activeReport && activeReport.remainingIssues > 0 && (
            <button
              type="button"
              onClick={() => onNavigate('repair')}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-[#0B192C] hover:bg-slate-50 whitespace-nowrap shrink-0 self-start sm:self-center"
            >
              <span>Review in Repair Data</span>
              <ArrowRight className="h-3.5 w-3.5 text-[#0284C7]" />
            </button>
          )}
        </div>
      </div>

      {notice && (
        <div
          role="status"
          data-testid="validation-notice-banner"
          className="rounded-lg border border-emerald-200 bg-emerald-50/80 px-4 py-3 text-sm text-emerald-900"
        >
          {notice}
        </div>
      )}

      {errorMessage && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {errorMessage}
        </div>
      )}

      {/* 5 Executive Before-and-After Comparison KPI Cards */}
      <section
        aria-label="Validation summary metrics"
        className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5"
      >
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <p className="text-xs font-medium text-slate-500">
            Total Issues Detected
          </p>
          <p
            data-testid="val-total-issues"
            className="mt-2 font-mono text-2xl font-semibold tabular-nums text-[#0B192C]"
          >
            {(activeReport?.totalIssuesDetected ?? 0).toLocaleString()}
          </p>
          <p className="mt-1 text-[11px] text-slate-500">
            Original baseline count
          </p>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <p className="text-xs font-medium text-slate-500">
            Issues Successfully Repaired
          </p>
          <p
            data-testid="val-confirmed-repairs"
            className="mt-2 font-mono text-2xl font-semibold tabular-nums text-emerald-700"
          >
            {(activeReport?.issuesSuccessfullyRepaired ?? 0).toLocaleString()}
          </p>
          <p className="mt-1 text-[11px] text-emerald-700/90 font-medium">
            Confirmed by validation engine
          </p>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <p className="text-xs font-medium text-slate-500">Remaining Issues</p>
          <p
            data-testid="val-remaining-issues"
            className={`mt-2 font-mono text-2xl font-semibold tabular-nums ${
              (activeReport?.remainingIssues ?? 0) > 0
                ? 'text-amber-700'
                : 'text-emerald-700'
            }`}
          >
            {(activeReport?.remainingIssues ?? 0).toLocaleString()}
          </p>
          <p className="mt-1 text-[11px] text-slate-500">
            After post-repair re-analysis
          </p>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <p className="text-xs font-medium text-slate-500">Failed Repairs</p>
          <p
            data-testid="val-failed-repairs"
            className={`mt-2 font-mono text-2xl font-semibold tabular-nums ${
              (activeReport?.failedRepairs ?? 0) > 0
                ? 'text-red-700'
                : 'text-[#0B192C]'
            }`}
          >
            {(activeReport?.failedRepairs ?? 0).toLocaleString()}
          </p>
          <p className="mt-1 text-[11px] text-slate-500">
            {(activeReport?.failedRepairs ?? 0) > 0
              ? 'Unresolved on re-analysis'
              : 'Zero failed verifications'}
          </p>
        </div>

        <div className="col-span-2 md:col-span-1 rounded-lg border border-[#D9B352]/70 bg-white p-4">
          <p className="text-xs font-medium text-slate-500">
            Quality Score Improvement
          </p>
          <p
            data-testid="val-score-improvement"
            className={`mt-2 font-mono text-2xl font-semibold tabular-nums ${
              scoreImprovement > 0
                ? 'text-emerald-700'
                : scoreImprovement < 0
                  ? 'text-red-700'
                  : 'text-[#0B192C]'
            }`}
          >
            {scoreImprovementFormatted}
          </p>
          <p className="mt-1 font-mono text-[11px] tabular-nums text-[#8F6A14]">
            {activeReport
              ? `${activeReport.originalQualityScore.toFixed(1)}% → ${activeReport.updatedQualityScore.toFixed(1)}%`
              : '0.0% → 0.0%'}
          </p>
        </div>
      </section>

      {/* Before vs. After Core Metrics Table (All 8 Required Calculations) */}
      <section
        aria-label="Before and after validation comparison metrics"
        className="rounded-lg border border-slate-200 bg-white overflow-hidden"
      >
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-[#0B192C]">
              Before vs. After Dataset Comparison
            </h2>
            <p className="text-xs text-slate-500">
              Calculated directly from untouched original records vs. re-analyzed post-repair records for{' '}
              <span className="font-mono text-[#0B192C]">
                {activeDataset?.name ?? 'selected dataset'}
              </span>
            </p>
          </div>
          {activeReport && !activeReport.reanalyzedAfterRepairs && activeReport.totalIssuesDetected > 0 && (
            <span className="text-xs font-medium text-amber-700 whitespace-nowrap">
              Awaiting approved repairs
            </span>
          )}
        </div>

        <div className="w-full overflow-x-auto">
          <table
            className="w-full min-w-[660px] border-collapse text-left text-sm"
            data-testid="before-after-comparison-table"
          >
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                <th className="py-3 pl-5 pr-3">Quality Metric</th>
                <th className="px-4 py-3 text-right">Original (Before Repair)</th>
                <th className="px-4 py-3 text-right">
                  Remaining / Updated (After Repair)
                </th>
                <th className="py-3 pl-4 pr-5 text-right">Validated Change</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {comparisonRows.map((row) => (
                <tr
                  key={row.label}
                  data-testid={row.testId}
                  className="hover:bg-[#EBF5FC]/40 transition-colors"
                >
                  <td className="py-3.5 pl-5 pr-3">
                    <div className="font-semibold text-[#0B192C]">{row.label}</div>
                    <div className="text-xs text-slate-500">{row.sublabel}</div>
                  </td>
                  <td className="px-4 py-3.5 text-right font-mono text-sm tabular-nums text-slate-600">
                    {row.beforeDisplay}
                  </td>
                  <td className="px-4 py-3.5 text-right font-mono text-sm font-semibold tabular-nums text-[#0B192C]">
                    {row.afterDisplay}
                  </td>
                  <td className="py-3.5 pl-4 pr-5 text-right font-mono text-xs font-semibold tabular-nums">
                    <span
                      className={
                        row.improved
                          ? 'text-emerald-700'
                          : row.degraded
                            ? 'text-red-700'
                            : 'text-slate-500'
                      }
                    >
                      {row.deltaDisplay}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Side-by-Side Comparison Charts */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <section className="rounded-lg border border-slate-200 bg-white p-5">
          <div className="pb-4 border-b border-slate-100">
            <h2 className="text-base font-semibold text-[#0B192C]">
              Before vs. After Detected Issues
            </h2>
            <p className="text-xs text-slate-500">
              Original issue count compared with remaining issues after validation re-analysis
            </p>
          </div>
          <div
            className="mt-4 h-64 w-full min-w-0"
            data-testid="validation-issues-chart"
          >
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <BarChart
                data={issueComparisonChartData}
                margin={{ top: 8, right: 16, left: -12, bottom: 0 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="#E2E8F0"
                  vertical={false}
                />
                <XAxis
                  dataKey="metric"
                  interval={0}
                  tick={{ fill: '#334155', fontSize: 11 }}
                  axisLine={{ stroke: '#E2E8F0' }}
                  tickLine={false}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fill: '#64748B', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0B192C',
                    border: '1px solid #1D3A61',
                    borderRadius: '6px',
                    color: '#F8FAFC',
                    fontSize: '12px',
                  }}
                />
                <Legend
                  itemSorter={() => 0}
                  wrapperStyle={{ fontSize: '12px' }}
                />
                <Bar
                  dataKey="original"
                  name="Original Issues"
                  fill="#0B192C"
                  radius={[4, 4, 0, 0]}
                  barSize={26}
                  isAnimationActive={false}
                />
                <Bar
                  dataKey="remaining"
                  name="Remaining Issues"
                  fill="#C4962C"
                  radius={[4, 4, 0, 0]}
                  barSize={26}
                  isAnimationActive={false}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-5">
          <div className="pb-4 border-b border-slate-100">
            <h2 className="text-base font-semibold text-[#0B192C]">
              Before vs. After Quality Dimensions
            </h2>
            <p className="text-xs text-slate-500">
              Score lift (%) across Completeness, Validity, Uniqueness, and Consistency
            </p>
          </div>
          <div
            className="mt-4 h-64 w-full min-w-0"
            data-testid="validation-comparison-chart"
          >
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <BarChart
                data={dimensionChartData}
                margin={{ top: 8, right: 12, left: -14, bottom: 0 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="#E2E8F0"
                  vertical={false}
                />
                <XAxis
                  dataKey="dimension"
                  interval={0}
                  tick={{ fill: '#334155', fontSize: 11 }}
                  axisLine={{ stroke: '#E2E8F0' }}
                  tickLine={false}
                />
                <YAxis
                  domain={[0, 100]}
                  tick={{ fill: '#64748B', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v) => `${v}%`}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0B192C',
                    border: '1px solid #1D3A61',
                    borderRadius: '6px',
                    color: '#F8FAFC',
                    fontSize: '12px',
                  }}
                />
                <Legend
                  itemSorter={() => 0}
                  wrapperStyle={{ fontSize: '12px' }}
                />
                <Bar
                  dataKey="before"
                  name="Before Repair (%)"
                  fill="#94A3B8"
                  radius={[4, 4, 0, 0]}
                  barSize={26}
                  isAnimationActive={false}
                />
                <Bar
                  dataKey="after"
                  name="After Repair (%)"
                  fill="#0284C7"
                  radius={[4, 4, 0, 0]}
                  barSize={26}
                  isAnimationActive={false}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
      </div>

      {/* Post-Repair Validation Confirmation Log */}
      <section
        aria-label="Repair validation confirmation log"
        className="rounded-lg border border-slate-200 bg-white overflow-hidden"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-[#0B192C]">
              Repair Confirmation Verification Log
            </h2>
            <p className="text-xs text-slate-500">
              Every approved change is independently checked against the re-analyzed dataset before being reported as repaired
            </p>
          </div>

          <div
            role="group"
            aria-label="Filter repair outcomes"
            className="flex items-center gap-1 rounded-md bg-slate-100 p-1 self-start sm:self-auto"
          >
            {(['All', 'Confirmed', 'Failed'] as OutcomeFilter[]).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setOutcomeFilter(mode)}
                className={`rounded px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors ${
                  outcomeFilter === mode
                    ? 'bg-white text-[#0B192C] shadow-xs'
                    : 'text-slate-600 hover:text-[#0B192C]'
                }`}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>

        <div className="w-full overflow-x-auto">
          <table
            className="w-full min-w-[860px] border-collapse text-left text-xs"
            data-testid="repair-verification-table"
          >
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                <th className="py-3 pl-5 pr-3 whitespace-nowrap">Validation</th>
                <th className="px-3 py-3 whitespace-nowrap">Row & Column</th>
                <th className="px-3 py-3 whitespace-nowrap">Issue Type</th>
                <th className="px-3 py-3 whitespace-nowrap">Original Value</th>
                <th className="px-3 py-3 whitespace-nowrap">Validated Value</th>
                <th className="px-3 py-3 whitespace-nowrap">Repair Method</th>
                <th className="py-3 pl-3 pr-5">Verification Result</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredOutcomes.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-9 text-center text-sm text-slate-500">
                    {(activeReport?.repairOutcomes.length ?? 0) === 0 ? (
                      <div className="flex flex-col items-center gap-2">
                        <span>
                          No approved repairs have been validated yet for{' '}
                          <span className="font-mono text-[#0B192C]">
                            {activeDataset?.name ?? 'this dataset'}
                          </span>
                          .
                        </span>
                        {onNavigate && (activeReport?.totalIssuesDetected ?? 0) > 0 && (
                          <button
                            type="button"
                            onClick={() => onNavigate('repair')}
                            className="inline-flex items-center gap-1.5 rounded-md bg-[#0B192C] px-3.5 py-1.5 text-xs font-medium text-white hover:bg-[#163155]"
                          >
                            <span>Go to Repair Data to Approve Repairs</span>
                            <ArrowRight className="h-3.5 w-3.5 text-[#D9B352]" />
                          </button>
                        )}
                      </div>
                    ) : (
                      `No ${outcomeFilter.toLowerCase()} repair verifications for this dataset.`
                    )}
                  </td>
                </tr>
              ) : (
                filteredOutcomes.map((item) => (
                  <tr
                    key={item.id}
                    data-testid="repair-verification-row"
                    className={`align-top transition-colors ${
                      item.status === 'Failed'
                        ? 'bg-red-50/45 hover:bg-red-50/75'
                        : 'hover:bg-[#EBF5FC]/40'
                    }`}
                  >
                    <td className="py-3 pl-5 pr-3 whitespace-nowrap">
                      {item.status === 'Confirmed' ? (
                        <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-700">
                          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                          <span>Confirmed</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 font-semibold text-red-700">
                          <XCircle className="h-3.5 w-3.5 shrink-0" />
                          <span>Failed</span>
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 font-mono whitespace-nowrap text-[#0B192C]">
                      <span>Row {item.rowNumber}</span>
                      {item.adjustedRowNumber !== null &&
                        item.adjustedRowNumber !== item.rowNumber && (
                          <span className="text-slate-400">
                            {' '}
                            (now Row {item.adjustedRowNumber})
                          </span>
                        )}
                      <span className="text-slate-300"> · </span>
                      <span className="text-[#0284C7] font-semibold">
                        {item.column}
                      </span>
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap font-medium text-slate-700">
                      {item.issueType}
                    </td>
                    <td className="px-3 py-3 font-mono text-red-700 max-w-[140px] break-words whitespace-pre-wrap">
                      {formatCellValue(item.originalValue)}
                    </td>
                    <td className="px-3 py-3 font-mono font-semibold text-emerald-700 max-w-[160px] break-words">
                      {item.repairedValue}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap text-slate-700">
                      {item.repairMethod}
                    </td>
                    <td className="py-3 pl-3 pr-5 text-slate-600 leading-relaxed max-w-[280px]">
                      {item.verificationNote}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Validation Gate Assertions Table */}
      <section className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 className="text-base font-semibold text-[#0B192C]">
            Validation Gate Assertions
          </h2>
          <span className="font-mono text-xs tabular-nums text-slate-500">
            {passedGateCount} / {datasetValidations.length} passed
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                <th className="py-3 pl-5 pr-3">Validation Check</th>
                <th className="px-3 py-3">Dimension</th>
                <th className="px-3 py-3 text-right">Before</th>
                <th className="px-3 py-3 text-right">After</th>
                <th className="px-3 py-3">Outcome</th>
                <th className="py-3 pl-3 pr-5">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {datasetValidations.map((check) => (
                <tr key={check.id} className="h-11 hover:bg-[#EBF5FC]/40">
                  <td className="py-3 pl-5 pr-3 font-medium text-[#0B192C]">
                    {check.checkName}
                  </td>
                  <td className="px-3 py-3 text-slate-600">{check.dimension}</td>
                  <td className="px-3 py-3 text-right font-mono tabular-nums text-slate-500">
                    {check.beforeScore.toFixed(1)}%
                  </td>
                  <td className="px-3 py-3 text-right font-mono tabular-nums font-semibold text-[#0B192C]">
                    {check.afterScore.toFixed(1)}%
                  </td>
                  <td className="px-3 py-3 text-xs font-semibold">
                    {check.passed ? (
                      <span className="inline-flex items-center gap-1 text-emerald-700">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        <span>Passed</span>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-amber-700">
                        <AlertTriangle className="h-3.5 w-3.5" />
                        <span>Review Required</span>
                      </span>
                    )}
                  </td>
                  <td className="py-3 pl-3 pr-5 text-xs text-slate-600">
                    {check.details}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Validated Deliverables Quick Export Strip */}
      <section className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between rounded-lg border border-slate-200 bg-white px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-[#0B192C]">
            Export Validated Deliverables
          </h2>
          <p className="text-xs text-slate-500">
            Download the Excel-ready Data Quality Report or Modification History for{' '}
            <span className="font-mono text-[#0B192C]">
              {activeDataset?.name ?? 'selected dataset'}
            </span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            disabled={!activeDataset || downloadingKey !== null}
            onClick={() => void handleDownloadReportDeliverable('quality-report')}
            className="inline-flex items-center gap-1.5 rounded-md bg-[#0B192C] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#163155] disabled:opacity-40 whitespace-nowrap"
          >
            {downloadingKey === 'quality-report' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-[#D9B352]" />
            ) : (
              <Download className="h-3.5 w-3.5 text-[#D9B352]" />
            )}
            <span>
              {downloadingKey === 'quality-report'
                ? 'Exporting...'
                : 'Quality Report (.xlsx)'}
            </span>
          </button>
          <button
            type="button"
            disabled={!activeDataset || downloadingKey !== null}
            onClick={() => void handleDownloadReportDeliverable('modifications')}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-[#0B192C] hover:bg-slate-50 disabled:opacity-40 whitespace-nowrap"
          >
            {downloadingKey === 'modifications' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-[#0284C7]" />
            ) : (
              <Download className="h-3.5 w-3.5 text-[#0284C7]" />
            )}
            <span>
              {downloadingKey === 'modifications'
                ? 'Exporting...'
                : 'Modification History (.xlsx)'}
            </span>
          </button>
          {onNavigate && (
            <>
              <button
                type="button"
                onClick={() => onNavigate('audit')}
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-[#0B192C] hover:bg-slate-50 whitespace-nowrap"
              >
                <span>Audit History</span>
                <ArrowRight className="h-3.5 w-3.5 text-[#0284C7]" />
              </button>
              <button
                type="button"
                onClick={() => onNavigate('reports')}
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-[#0B192C] hover:bg-slate-50 whitespace-nowrap"
              >
                <span>All Export Options</span>
                <ArrowRight className="h-3.5 w-3.5 text-[#0284C7]" />
              </button>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
