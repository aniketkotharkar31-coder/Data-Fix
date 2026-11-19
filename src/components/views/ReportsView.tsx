import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  Download,
  FilePlus2,
  FileSpreadsheet,
  FileText,
  History,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { datafixApi } from '../../services/api';
import type {
  AuditModificationRecord,
  DataQualityReportExport,
  DatasetRecord,
  NavSectionId,
  ReportSummary,
  ValidationComparisonReport,
} from '../../types/datafix';

import { downloadFileFromApi } from '../../utils/downloadFile';

interface ReportsViewProps {
  datasets: DatasetRecord[];
  selectedDatasetId: string;
  onSelectDataset: (id: string) => void;
  reports: ReportSummary[];
  validationReports: ValidationComparisonReport[];
  auditModifications: AuditModificationRecord[];
  onReportGenerated: () => Promise<void> | void;
  onNavigate?: (section: NavSectionId) => void;
}

export function ReportsView({
  datasets,
  selectedDatasetId,
  onSelectDataset,
  reports,
  validationReports,
  auditModifications,
  onReportGenerated,
  onNavigate,
}: ReportsViewProps) {
  const effectiveDatasetId = useMemo(() => {
    if (
      selectedDatasetId &&
      selectedDatasetId !== 'ALL' &&
      datasets.some((d) => d.id === selectedDatasetId)
    ) {
      return selectedDatasetId;
    }
    return datasets[0]?.id ?? '';
  }, [datasets, selectedDatasetId]);

  const activeDataset = useMemo(
    () => datasets.find((d) => d.id === effectiveDatasetId) ?? null,
    [datasets, effectiveDatasetId]
  );

  const activeValidationReport = useMemo(
    () =>
      validationReports.find((r) => r.datasetId === effectiveDatasetId) ?? null,
    [validationReports, effectiveDatasetId]
  );

  const datasetModifications = useMemo(
    () => auditModifications.filter((m) => m.datasetId === effectiveDatasetId),
    [auditModifications, effectiveDatasetId]
  );

  const activeApprovedModificationsCount = useMemo(
    () =>
      datasetModifications.filter((m) => m.validationStatus !== 'Reverted')
        .length,
    [datasetModifications]
  );

  const [qualityReport, setQualityReport] =
    useState<DataQualityReportExport | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewNonce, setPreviewNonce] = useState(0);
  const [format, setFormat] = useState<'XLSX' | 'CSV' | 'JSON'>('XLSX');
  const [generating, setGenerating] = useState(false);
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!effectiveDatasetId) {
      setQualityReport(null);
      setPreviewError(null);
      return;
    }
    let cancelled = false;
    setLoadingPreview(true);
    setPreviewError(null);
    datafixApi
      .getDatasetQualityReport(effectiveDatasetId)
      .then((res) => {
        if (!cancelled) {
          setQualityReport(res.report);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setQualityReport(null);
          setPreviewError(
            err instanceof Error
              ? err.message
              : 'Unable to load the live Data Quality Report preview.'
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingPreview(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    effectiveDatasetId,
    activeDataset?.qualityScore,
    activeDataset?.rows,
    activeDataset?.repairedCells,
    activeApprovedModificationsCount,
    previewNonce,
  ]);

  const benchmarkData = useMemo(
    () =>
      datasets.map((ds) => ({
        name: ds.name.replace(/\.(csv|xlsx|xls)$/i, ''),
        score: ds.qualityScore,
      })),
    [datasets]
  );

  const baseFilename = activeDataset
    ? activeDataset.name.replace(/\.(csv|xlsx|xls)$/i, '')
    : 'dataset';

  const handleDownloadCleaned = async (fileFormat: 'csv' | 'xlsx') => {
    if (!activeDataset) return;
    const key = `cleaned-${fileFormat}`;
    setDownloadingKey(key);
    setErrorMessage(null);
    setNotice(null);
    try {
      const url = datafixApi.getExportUrl(activeDataset.id, fileFormat);
      const { filename } = await downloadFileFromApi(
        url,
        `${baseFilename}_cleaned.${fileFormat}`
      );
      setNotice(
        `Exported cleaned ${fileFormat.toUpperCase()} dataset "${filename}" containing only approved modifications.`
      );
      await onReportGenerated();
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : `Unable to export cleaned ${fileFormat.toUpperCase()} dataset.`
      );
    } finally {
      setDownloadingKey(null);
    }
  };

  const handleDownloadQualityReport = async (
    fileFormat: 'xlsx' | 'csv' | 'json'
  ) => {
    if (!activeDataset) return;
    const key = `quality-${fileFormat}`;
    setDownloadingKey(key);
    setErrorMessage(null);
    setNotice(null);
    try {
      const url = datafixApi.getQualityReportExportUrl(
        activeDataset.id,
        fileFormat
      );
      const { filename } = await downloadFileFromApi(
        url,
        `${baseFilename}_quality_report.${fileFormat}`
      );
      setNotice(
        `Downloaded Data Quality Report "${filename}" with original statistics, detected issues, applied repairs, remaining issues, validation results, and final quality score.`
      );
      await onReportGenerated();
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : `Unable to export Data Quality Report (${fileFormat.toUpperCase()}).`
      );
    } finally {
      setDownloadingKey(null);
    }
  };

  const handleDownloadModifications = async (fileFormat: 'xlsx' | 'csv') => {
    if (!activeDataset) return;
    const key = `mods-${fileFormat}`;
    setDownloadingKey(key);
    setErrorMessage(null);
    setNotice(null);
    try {
      const url = datafixApi.getDatasetModificationsExportUrl(
        activeDataset.id,
        fileFormat
      );
      const { filename } = await downloadFileFromApi(
        url,
        `${baseFilename}_modification_history.${fileFormat}`
      );
      setNotice(
        `Downloaded Modification History "${filename}" (${datasetModifications.length} ${
          datasetModifications.length === 1 ? 'record' : 'records'
        }).`
      );
      await onReportGenerated();
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : `Unable to export Modification History (${fileFormat.toUpperCase()}).`
      );
    } finally {
      setDownloadingKey(null);
    }
  };

  const handleGenerateReport = async () => {
    if (!effectiveDatasetId) return;
    setGenerating(true);
    setNotice(null);
    setErrorMessage(null);
    try {
      const result = await datafixApi.generateReport(effectiveDatasetId, format);
      setNotice(
        `Saved "${result.report.title}" (${result.report.format}) to the report catalog.`
      );
      await onReportGenerated();
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Unable to generate report.'
      );
    } finally {
      setGenerating(false);
    }
  };

  const handleExportCatalogReport = async (report: ReportSummary) => {
    const fmt =
      report.format === 'JSON'
        ? 'json'
        : report.format === 'CSV'
          ? 'csv'
          : 'xlsx';
    const key = `catalog-${report.id}`;
    setDownloadingKey(key);
    setErrorMessage(null);
    setNotice(null);
    try {
      const base = report.datasetName.replace(/\.(csv|xlsx|xls)$/i, '');
      const url = datafixApi.getQualityReportExportUrl(report.datasetId, fmt);
      const { filename } = await downloadFileFromApi(
        url,
        `${base}_quality_report.${fmt}`
      );
      setNotice(
        `Downloaded "${filename}" from the quality report catalog.`
      );
      await onReportGenerated();
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : 'Unable to download catalog report.'
      );
    } finally {
      setDownloadingKey(null);
    }
  };

  const origStats = qualityReport?.originalDatasetStatistics;
  const valResults = qualityReport?.validationResults;
  const finalScore = qualityReport?.finalQualityScore;

  const originalRowsCount =
    origStats?.originalRowCount ??
    activeValidationReport?.originalRowCount ??
    activeDataset?.rows ??
    0;
  const currentRowsCount =
    origStats?.currentRowCount ??
    activeValidationReport?.currentRowCount ??
    activeDataset?.rows ??
    0;
  const detectedIssuesCount =
    qualityReport?.detectedIssues.length ??
    activeValidationReport?.totalIssuesDetected ??
    0;
  const appliedRepairsCount =
    qualityReport?.appliedRepairs.length ?? activeApprovedModificationsCount;
  const remainingIssuesCount =
    qualityReport?.remainingIssues.length ??
    activeValidationReport?.remainingIssues ??
    activeDataset?.openIssues ??
    0;
  const confirmedRepairsCount =
    valResults?.issuesSuccessfullyRepaired ??
    activeValidationReport?.issuesSuccessfullyRepaired ??
    0;
  const failedRepairsCount =
    valResults?.failedRepairs ?? activeValidationReport?.failedRepairs ?? 0;
  const originalScoreValue =
    finalScore?.originalScore ??
    activeValidationReport?.originalQualityScore ??
    activeDataset?.previousScore ??
    0;
  const finalScoreValue =
    finalScore?.finalScore ??
    activeValidationReport?.updatedQualityScore ??
    activeDataset?.qualityScore ??
    0;
  const scoreLift =
    finalScore?.improvement ??
    activeValidationReport?.qualityScoreImprovement ??
    Number((finalScoreValue - originalScoreValue).toFixed(1));
  const validationStatusText =
    valResults?.validationStatus ??
    activeValidationReport?.validationStatus ??
    activeDataset?.status ??
    '—';
  const passedChecksCount = (
    valResults?.checks ??
    activeValidationReport?.checks ??
    []
  ).filter((c) => c.passed).length;
  const totalChecksCount = (
    valResults?.checks ??
    activeValidationReport?.checks ??
    []
  ).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[#0B192C]">
            Export &amp; Reports
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Download cleaned datasets containing only approved modifications, full multi-sheet Data Quality Reports, and Modification History files ready for Microsoft Excel.
          </p>
        </div>

        {onNavigate && (
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => onNavigate('validation')}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-[#0B192C] hover:bg-slate-50 whitespace-nowrap"
            >
              <span>Validation Summary</span>
              <ArrowRight className="h-3.5 w-3.5 text-[#0284C7]" />
            </button>
            <button
              type="button"
              onClick={() => onNavigate('audit')}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-[#0B192C] hover:bg-slate-50 whitespace-nowrap"
            >
              <span>Audit History</span>
              <ArrowRight className="h-3.5 w-3.5 text-[#0284C7]" />
            </button>
          </div>
        )}
      </div>

      {/* Dataset Selector & Approved-Only Provenance Bar */}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="lg:col-span-5 rounded-lg border border-slate-200 bg-white p-4">
          <label
            htmlFor="export-dataset-select"
            className="block text-xs font-medium text-slate-500"
          >
            Dataset to Export
          </label>
          <select
            id="export-dataset-select"
            data-testid="export-dataset-select"
            value={effectiveDatasetId}
            onChange={(e) => {
              onSelectDataset(e.target.value);
              setNotice(null);
              setErrorMessage(null);
            }}
            className="mt-1.5 w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium text-[#0B192C] focus:border-[#0284C7] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0284C7]/20"
          >
            {datasets.map((ds) => (
              <option key={ds.id} value={ds.id}>
                {ds.name} ({ds.qualityScore.toFixed(1)}% · {ds.status})
              </option>
            ))}
          </select>
        </div>

        <div className="lg:col-span-7 rounded-lg border border-slate-200 bg-white p-4 flex flex-col justify-center gap-1.5">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <ShieldCheck
              aria-hidden="true"
              className="h-4 w-4 text-[#0284C7] shrink-0"
            />
            <span className="font-semibold text-[#0B192C]">
              Approved-Modifications-Only Guarantee:
            </span>
            <span className="text-slate-600">
              Unapproved suggestions and manual-review anomalies are never altered in exported datasets.
            </span>
          </div>
          {activeDataset && (
            <p className="text-xs text-slate-600">
              Active target:{' '}
              <span className="font-mono font-semibold text-[#0B192C]">
                {activeDataset.name}
              </span>{' '}
              ·{' '}
              <span className="font-mono tabular-nums font-semibold text-[#0B192C]">
                {currentRowsCount.toLocaleString()}
              </span>{' '}
              rows ×{' '}
              <span className="font-mono tabular-nums font-semibold text-[#0B192C]">
                {activeDataset.columns}
              </span>{' '}
              columns ·{' '}
              <span className="font-mono tabular-nums font-semibold text-emerald-700">
                {appliedRepairsCount.toLocaleString()}
              </span>{' '}
              approved {appliedRepairsCount === 1 ? 'modification' : 'modifications'} applied · Final score{' '}
              <span className="font-mono tabular-nums font-semibold text-[#0B192C]">
                {finalScoreValue.toFixed(1)}%
              </span>
            </p>
          )}
        </div>
      </section>

      {notice && (
        <div
          role="status"
          data-testid="export-notice-banner"
          className="flex items-start gap-2.5 rounded-lg border border-emerald-200 bg-emerald-50/80 px-4 py-3 text-sm text-emerald-900"
        >
          <CheckCircle2
            aria-hidden="true"
            className="h-4 w-4 mt-0.5 text-emerald-700 shrink-0"
          />
          <span>{notice}</span>
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

      {/* 4 Primary Export Deliverables */}
      <section
        aria-label="Export deliverables"
        className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4"
      >
        {/* 1. Cleaned CSV Dataset */}
        <article className="flex flex-col justify-between rounded-lg border border-slate-200 bg-white p-5">
          <div>
            <div className="flex items-center justify-between gap-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-md bg-[#0B192C] text-[#D9B352]">
                <FileText className="h-4 w-4" aria-hidden="true" />
              </div>
              <span className="font-mono text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                UTF-8 CSV · Excel Ready
              </span>
            </div>
            <h2 className="mt-3.5 text-base font-semibold text-[#0B192C]">
              Cleaned CSV Dataset
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-600">
              Exports{' '}
              <span className="font-mono tabular-nums font-semibold text-[#0B192C]">
                {currentRowsCount.toLocaleString()}
              </span>{' '}
              rows with UTF-8 BOM and CRLF formatting so Microsoft Excel opens every column cleanly. Contains only approved changes.
            </p>
          </div>

          <div className="mt-5 pt-4 border-t border-slate-100">
            <button
              type="button"
              disabled={!activeDataset || downloadingKey !== null}
              onClick={() => void handleDownloadCleaned('csv')}
              data-testid="export-cleaned-csv-btn"
              className="w-full inline-flex items-center justify-center gap-2 rounded-md bg-[#0B192C] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#163155] disabled:opacity-40 whitespace-nowrap"
            >
              {downloadingKey === 'cleaned-csv' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-[#D9B352]" />
              ) : (
                <Download className="h-3.5 w-3.5 text-[#D9B352]" />
              )}
              <span>
                {downloadingKey === 'cleaned-csv'
                  ? 'Exporting CSV...'
                  : 'Download Cleaned CSV'}
              </span>
            </button>
          </div>
        </article>

        {/* 2. Cleaned Excel Dataset */}
        <article className="flex flex-col justify-between rounded-lg border border-slate-200 bg-white p-5">
          <div>
            <div className="flex items-center justify-between gap-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-md bg-[#0284C7] text-white">
                <FileSpreadsheet className="h-4 w-4" aria-hidden="true" />
              </div>
              <span className="font-mono text-[11px] font-semibold uppercase tracking-wide text-[#0284C7]">
                .XLSX Workbook
              </span>
            </div>
            <h2 className="mt-3.5 text-base font-semibold text-[#0B192C]">
              Cleaned Excel Dataset
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-600">
              Native Excel workbook (<span className="font-mono">CleanedData</span> sheet) preserving exact column order, numeric types, auto-sized columns, and approved repairs only.
            </p>
          </div>

          <div className="mt-5 pt-4 border-t border-slate-100">
            <button
              type="button"
              disabled={!activeDataset || downloadingKey !== null}
              onClick={() => void handleDownloadCleaned('xlsx')}
              data-testid="export-cleaned-xlsx-btn"
              className="w-full inline-flex items-center justify-center gap-2 rounded-md bg-[#0284C7] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#0369A1] disabled:opacity-40 whitespace-nowrap"
            >
              {downloadingKey === 'cleaned-xlsx' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              <span>
                {downloadingKey === 'cleaned-xlsx'
                  ? 'Exporting Excel...'
                  : 'Download Cleaned Excel'}
              </span>
            </button>
          </div>
        </article>

        {/* 3. Data Quality Report */}
        <article className="flex flex-col justify-between rounded-lg border border-[#D9B352]/70 bg-white p-5">
          <div>
            <div className="flex items-center justify-between gap-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-md bg-[#0B192C] text-[#D9B352]">
                <ClipboardList className="h-4 w-4" aria-hidden="true" />
              </div>
              <span className="font-mono text-[11px] font-semibold uppercase tracking-wide text-[#8F6A14] whitespace-nowrap">
                5-Sheet .XLSX
              </span>
            </div>
            <h2 className="mt-3.5 text-base font-semibold text-[#0B192C]">
              Data Quality Report
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-600">
              Complete audit-grade workbook containing original statistics, detected issues, applied repairs, remaining issues, validation results, and final quality score.
            </p>
          </div>

          <div className="mt-5 pt-4 border-t border-slate-100 space-y-2">
            <button
              type="button"
              disabled={!activeDataset || downloadingKey !== null}
              onClick={() => void handleDownloadQualityReport('xlsx')}
              data-testid="export-quality-report-xlsx-btn"
              className="w-full inline-flex items-center justify-center gap-2 rounded-md bg-[#0B192C] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#163155] disabled:opacity-40 whitespace-nowrap"
            >
              {downloadingKey === 'quality-xlsx' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-[#D9B352]" />
              ) : (
                <Download className="h-3.5 w-3.5 text-[#D9B352]" />
              )}
              <span>
                {downloadingKey === 'quality-xlsx'
                  ? 'Building Report...'
                  : 'Download Quality Report (.xlsx)'}
              </span>
            </button>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={!activeDataset || downloadingKey !== null}
                onClick={() => void handleDownloadQualityReport('csv')}
                data-testid="export-quality-report-csv-btn"
                className="inline-flex items-center justify-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-[#0B192C] hover:bg-slate-50 disabled:opacity-40 whitespace-nowrap"
              >
                {downloadingKey === 'quality-csv' ? (
                  <Loader2 className="h-3 w-3 animate-spin text-[#0284C7]" />
                ) : (
                  <Download className="h-3 w-3 text-[#0284C7]" />
                )}
                <span>{downloadingKey === 'quality-csv' ? 'Exporting...' : 'CSV'}</span>
              </button>
              <button
                type="button"
                disabled={!activeDataset || downloadingKey !== null}
                onClick={() => void handleDownloadQualityReport('json')}
                data-testid="export-quality-report-json-btn"
                className="inline-flex items-center justify-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-[#0B192C] hover:bg-slate-50 disabled:opacity-40 whitespace-nowrap"
              >
                {downloadingKey === 'quality-json' ? (
                  <Loader2 className="h-3 w-3 animate-spin text-[#0284C7]" />
                ) : (
                  <Download className="h-3 w-3 text-[#0284C7]" />
                )}
                <span>{downloadingKey === 'quality-json' ? 'Exporting...' : 'JSON'}</span>
              </button>
            </div>
          </div>
        </article>

        {/* 4. Modification History */}
        <article className="flex flex-col justify-between rounded-lg border border-slate-200 bg-white p-5">
          <div>
            <div className="flex items-center justify-between gap-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-md bg-slate-100 text-[#0B192C]">
                <History className="h-4 w-4" aria-hidden="true" />
              </div>
              <span className="font-mono text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {datasetModifications.length.toLocaleString()}{' '}
                {datasetModifications.length === 1 ? 'Entry' : 'Entries'}
              </span>
            </div>
            <h2 className="mt-3.5 text-base font-semibold text-[#0B192C]">
              Modification History
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-600">
              Row-level audit trail for this dataset recording row number, column, original &amp; updated values, reason, repair method, timestamp, and validation status.
            </p>
          </div>

          <div className="mt-5 pt-4 border-t border-slate-100 space-y-2">
            <button
              type="button"
              disabled={!activeDataset || downloadingKey !== null}
              onClick={() => void handleDownloadModifications('xlsx')}
              data-testid="export-modifications-xlsx-btn"
              className="w-full inline-flex items-center justify-center gap-2 rounded-md border border-[#0B192C] bg-white px-3.5 py-2 text-xs font-semibold text-[#0B192C] hover:bg-slate-50 disabled:opacity-40 whitespace-nowrap"
            >
              {downloadingKey === 'mods-xlsx' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-[#0284C7]" />
              ) : (
                <Download className="h-3.5 w-3.5 text-[#0284C7]" />
              )}
              <span>
                {downloadingKey === 'mods-xlsx'
                  ? 'Exporting History...'
                  : 'Download History (.xlsx)'}
              </span>
            </button>
            <button
              type="button"
              disabled={!activeDataset || downloadingKey !== null}
              onClick={() => void handleDownloadModifications('csv')}
              data-testid="export-modifications-csv-btn"
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40 whitespace-nowrap"
            >
              {downloadingKey === 'mods-csv' ? (
                <Loader2 className="h-3 w-3 animate-spin text-[#0284C7]" />
              ) : (
                <Download className="h-3 w-3 text-[#0284C7]" />
              )}
              <span>
                {downloadingKey === 'mods-csv'
                  ? 'Exporting CSV...'
                  : 'Download History (CSV)'}
              </span>
            </button>
          </div>
        </article>
      </section>

      {/* Data Quality Report Contents Preview (All 6 Required Sections) */}
      <section
        aria-label="Data quality report preview"
        data-testid="quality-report-preview"
        className="rounded-lg border border-slate-200 bg-white overflow-hidden"
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-[#0B192C]">
              Data Quality Report Contents Preview
            </h2>
            <p className="text-xs text-slate-500">
              Live snapshot of all six sections included inside the downloadable Data Quality Report for{' '}
              <span className="font-mono text-[#0B192C]">
                {activeDataset?.name ?? 'selected dataset'}
              </span>
            </p>
          </div>
          {loadingPreview && (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 whitespace-nowrap">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-[#0284C7]" />
              <span>Refreshing report snapshot...</span>
            </span>
          )}
        </div>

        {previewError && (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-2 border-b border-red-200 bg-red-50 px-5 py-2.5 text-xs text-red-800"
          >
            <span className="inline-flex items-center gap-2">
              <AlertCircle className="h-3.5 w-3.5 text-red-700 shrink-0" />
              <span>{previewError}</span>
            </span>
            <button
              type="button"
              onClick={() => setPreviewNonce((n) => n + 1)}
              className="inline-flex items-center gap-1 rounded border border-red-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-red-800 hover:bg-red-50 whitespace-nowrap"
            >
              <RefreshCw className="h-3 w-3" />
              <span>Retry</span>
            </button>
          </div>
        )}

        <div className="grid grid-cols-1 divide-y divide-slate-100 md:grid-cols-2 md:divide-y-0 lg:grid-cols-3">
          {/* 1. Original Dataset Statistics */}
          <div
            data-testid="preview-section-original-stats"
            className="p-5 border-b border-slate-100 md:border-r"
          >
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[#0284C7]">
              01 · Original Dataset Statistics
            </p>
            <dl className="mt-3 space-y-1.5 text-xs">
              <div className="flex items-center justify-between gap-2">
                <dt className="text-slate-500">Original → Cleaned Rows</dt>
                <dd className="font-mono font-semibold tabular-nums text-[#0B192C]">
                  {originalRowsCount.toLocaleString()} →{' '}
                  {currentRowsCount.toLocaleString()}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-slate-500">Total Columns</dt>
                <dd className="font-mono font-semibold tabular-nums text-[#0B192C]">
                  {origStats?.totalColumns ?? activeDataset?.columns ?? 0}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-slate-500">Original Missing / Dup / Invalid</dt>
                <dd className="font-mono font-semibold tabular-nums text-[#0B192C]">
                  {origStats?.originalMissingValues ??
                    activeValidationReport?.originalMissingValues ??
                    0}{' '}
                  /{' '}
                  {origStats?.originalDuplicateRecords ??
                    activeValidationReport?.originalDuplicateRecords ??
                    0}{' '}
                  /{' '}
                  {origStats?.originalInvalidEntries ??
                    activeValidationReport?.originalInvalidEntries ??
                    0}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-slate-500">Baseline Quality Score</dt>
                <dd className="font-mono font-semibold tabular-nums text-slate-700">
                  {originalScoreValue.toFixed(1)}%
                </dd>
              </div>
            </dl>
          </div>

          {/* 2. Detected Issues */}
          <div
            data-testid="preview-section-detected-issues"
            className="p-5 border-b border-slate-100 lg:border-r"
          >
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[#0284C7]">
              02 · Detected Issues (Baseline)
            </p>
            <p className="mt-2 font-mono text-2xl font-semibold tabular-nums text-[#0B192C]">
              {detectedIssuesCount.toLocaleString()}
            </p>
            <p className="mt-1 text-xs text-slate-600">
              Row-level quality findings originally detected across missing values, duplicate records, invalid formats, inconsistencies, and IQR anomalies.
            </p>
          </div>

          {/* 3. Applied Repairs */}
          <div
            data-testid="preview-section-applied-repairs"
            className="p-5 border-b border-slate-100 md:border-r lg:border-r-0"
          >
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[#0284C7]">
              03 · Applied Repairs (Approved)
            </p>
            <p className="mt-2 font-mono text-2xl font-semibold tabular-nums text-emerald-700">
              {appliedRepairsCount.toLocaleString()}
            </p>
            <p className="mt-1 text-xs text-slate-600">
              Approved modifications logged with original &amp; updated values, repair method, timestamp, and validation status.
            </p>
          </div>

          {/* 4. Remaining Issues */}
          <div
            data-testid="preview-section-remaining-issues"
            className="p-5 border-b md:border-b-0 border-slate-100 lg:border-r"
          >
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[#0284C7]">
              04 · Remaining Issues
            </p>
            <p
              className={`mt-2 font-mono text-2xl font-semibold tabular-nums ${
                remainingIssuesCount > 0 ? 'text-amber-700' : 'text-emerald-700'
              }`}
            >
              {remainingIssuesCount.toLocaleString()}
            </p>
            <p className="mt-1 text-xs text-slate-600">
              Open findings remaining after post-repair re-analysis (unapproved items or anomalies preserved for manual review).
            </p>
          </div>

          {/* 5. Validation Results */}
          <div
            data-testid="preview-section-validation-results"
            className="p-5 border-b md:border-b-0 border-slate-100 md:border-r"
          >
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[#0284C7]">
              05 · Validation Results
            </p>
            <dl className="mt-3 space-y-1.5 text-xs">
              <div className="flex items-center justify-between gap-2">
                <dt className="text-slate-500">Validation Status</dt>
                <dd className="font-semibold text-[#0B192C]">
                  {validationStatusText}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-slate-500">Confirmed / Failed Repairs</dt>
                <dd className="font-mono font-semibold tabular-nums">
                  <span className="text-emerald-700">
                    {confirmedRepairsCount}
                  </span>{' '}
                  /{' '}
                  <span
                    className={
                      failedRepairsCount > 0 ? 'text-red-700' : 'text-slate-600'
                    }
                  >
                    {failedRepairsCount}
                  </span>
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-slate-500">Validation Gates Passed</dt>
                <dd className="font-mono font-semibold tabular-nums text-[#0B192C]">
                  {passedChecksCount} / {totalChecksCount}
                </dd>
              </div>
            </dl>
          </div>

          {/* 6. Final Quality Score */}
          <div
            data-testid="preview-section-final-score"
            className="p-5 bg-[#FBF9F3]/60"
          >
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8F6A14]">
              06 · Final Quality Score
            </p>
            <div className="mt-2 flex items-baseline gap-2.5">
              <span className="font-mono text-2xl font-semibold tabular-nums text-[#0B192C]">
                {finalScoreValue.toFixed(1)}%
              </span>
              <span
                className={`font-mono text-xs font-semibold tabular-nums ${
                  scoreLift > 0
                    ? 'text-emerald-700'
                    : scoreLift < 0
                      ? 'text-red-700'
                      : 'text-slate-500'
                }`}
              >
                ({scoreLift > 0 ? '+' : ''}
                {scoreLift.toFixed(1)}% vs baseline)
              </span>
            </div>
            <p className="mt-1 text-xs text-slate-600">
              Grade{' '}
              <span className="font-mono font-semibold text-[#0B192C]">
                {finalScore?.grade ?? '—'}
              </span>{' '}
              · Includes Completeness, Validity, Uniqueness, and Consistency breakdown in the exported report.
            </p>
          </div>
        </div>
      </section>

      {/* Benchmark Chart */}
      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <div className="pb-4 border-b border-slate-100">
          <h2 className="text-base font-semibold text-[#0B192C]">
            Quality Score by Dataset
          </h2>
          <p className="text-xs text-slate-500">
            Current composite quality score (%) across workspace datasets
          </p>
        </div>

        <div
          className="mt-4 h-60 w-full min-w-0"
          data-testid="reports-benchmark-chart"
        >
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <BarChart
              data={benchmarkData}
              margin={{ top: 8, right: 16, left: -12, bottom: 0 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="#E2E8F0"
                vertical={false}
              />
              <XAxis
                dataKey="name"
                tick={{ fill: '#334155', fontSize: 12 }}
                axisLine={{ stroke: '#E2E8F0' }}
                tickLine={false}
              />
              <YAxis
                domain={[0, 100]}
                tick={{ fill: '#64748B', fontSize: 12 }}
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
              <Bar
                dataKey="score"
                name="Quality Score (%)"
                fill="#0B192C"
                radius={[4, 4, 0, 0]}
                barSize={38}
                isAnimationActive={false}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      {/* Saved Quality Report Catalog & On-Demand Snapshot Generator */}
      <section className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-[#0B192C]">
              Saved Quality Reports Catalog
            </h2>
            <p className="text-xs text-slate-500">
              Archive a dated report entry for governance tracking or download the full report workbook
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="report-format-select" className="sr-only">
              Catalog Report Format
            </label>
            <select
              id="report-format-select"
              value={format}
              onChange={(e) => {
                const v = e.target.value;
                setFormat(v === 'JSON' ? 'JSON' : v === 'CSV' ? 'CSV' : 'XLSX');
              }}
              className="rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-[#0B192C] focus:border-[#0284C7] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0284C7]/20"
            >
              <option value="XLSX">Excel (.xlsx)</option>
              <option value="CSV">CSV (.csv)</option>
              <option value="JSON">JSON (.json)</option>
            </select>

            <button
              type="button"
              disabled={generating || !effectiveDatasetId}
              onClick={handleGenerateReport}
              data-testid="generate-report-btn"
              className="inline-flex items-center justify-center gap-1.5 rounded-md bg-[#0B192C] px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-[#163155] disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              {generating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-[#D9B352]" />
              ) : (
                <FilePlus2 className="h-3.5 w-3.5 text-[#D9B352]" />
              )}
              <span>{generating ? 'Saving...' : 'Save Report Snapshot'}</span>
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[700px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                <th className="py-3 pl-5 pr-3">Report Title</th>
                <th className="px-3 py-3">Dataset</th>
                <th className="px-3 py-3 text-right">Quality Score</th>
                <th className="px-3 py-3 text-right">Issues Resolved</th>
                <th className="px-3 py-3">Generated</th>
                <th className="py-3 pl-3 pr-5 text-right">Download</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {reports.map((report) => (
                <tr key={report.id} className="h-11 hover:bg-[#EBF5FC]/40">
                  <td className="py-3 pl-5 pr-3 font-medium text-[#0B192C]">
                    {report.title}
                  </td>
                  <td className="px-3 py-3 font-mono text-xs text-slate-600">
                    {report.datasetName}
                  </td>
                  <td className="px-3 py-3 text-right font-mono tabular-nums font-semibold text-[#0B192C]">
                    {report.qualityScore.toFixed(1)}%
                  </td>
                  <td className="px-3 py-3 text-right font-mono tabular-nums text-slate-700">
                    {report.issuesResolved.toLocaleString()}
                  </td>
                  <td className="px-3 py-3 font-mono text-xs tabular-nums text-slate-500">
                    {report.generatedAt}
                  </td>
                  <td className="py-3 pl-3 pr-5 text-right">
                    <button
                      type="button"
                      disabled={downloadingKey !== null}
                      onClick={() => void handleExportCatalogReport(report)}
                      className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#0284C7] hover:text-[#0B192C] disabled:opacity-40 whitespace-nowrap"
                    >
                      {downloadingKey === `catalog-${report.id}` ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Download className="h-3.5 w-3.5" />
                      )}
                      <span>
                        {downloadingKey === `catalog-${report.id}`
                          ? 'Downloading...'
                          : `Download ${report.format}`}
                      </span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
