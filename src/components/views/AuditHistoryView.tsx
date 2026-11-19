import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Clock,
  Download,
  FileJson,
  FileSpreadsheet,
  FilterX,
  Loader2,
  RotateCcw,
  Search,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { datafixApi } from '../../services/api';
import type {
  AuditEntry,
  AuditModificationRecord,
  AuditModificationValidationStatus,
  DatasetRecord,
  NavSectionId,
} from '../../types/datafix';
import { downloadFileFromApi } from '../../utils/downloadFile';
import {
  serializeRowsToCsv,
  triggerTextDownload,
} from '../../utils/qualityMetrics';

interface AuditHistoryViewProps {
  datasets: DatasetRecord[];
  selectedDatasetId: string;
  onSelectDataset: (id: string) => void;
  audits: AuditEntry[];
  modifications: AuditModificationRecord[];
  onNavigate?: (section: NavSectionId) => void;
  onAuditExported?: () => Promise<void> | void;
}

type AuditTab = 'modifications' | 'activity';
type ValidationStatusFilter = 'All' | AuditModificationValidationStatus;

const ACTIVITY_STAGES: ('All' | AuditEntry['stage'])[] = [
  'All',
  'Upload',
  'Detect',
  'Diagnosis',
  'Repair',
  'Validation',
  'Export',
];

const STATUS_FILTERS: ValidationStatusFilter[] = [
  'All',
  'Confirmed',
  'Failed',
  'Pending Validation',
  'Reverted',
];

function formatCellValue(value: string): string {
  if (value !== value.trim()) {
    return `"${value}"`;
  }
  return value;
}

export function AuditHistoryView({
  datasets,
  selectedDatasetId,
  onSelectDataset,
  audits,
  modifications,
  onNavigate,
  onAuditExported,
}: AuditHistoryViewProps) {
  const [activeTab, setActiveTab] = useState<AuditTab>('modifications');

  // Modification history filters
  const [datasetFilter, setDatasetFilter] = useState<string>(
    selectedDatasetId && selectedDatasetId !== 'ALL' ? selectedDatasetId : 'ALL'
  );
  const [columnFilter, setColumnFilter] = useState<string>('ALL');
  const [methodFilter, setMethodFilter] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<ValidationStatusFilter>('All');
  const [modSearchQuery, setModSearchQuery] = useState<string>('');
  const [downloadingFormat, setDownloadingFormat] = useState<
    'csv' | 'xlsx' | 'json' | null
  >(null);
  const [exportError, setExportError] = useState<string | null>(null);

  // Keep dataset filter synchronized with the shared active dataset state
  useEffect(() => {
    const nextFilter =
      selectedDatasetId && selectedDatasetId !== 'ALL'
        ? selectedDatasetId
        : 'ALL';
    setDatasetFilter(nextFilter);
    setColumnFilter('ALL');
    setMethodFilter('ALL');
  }, [selectedDatasetId]);

  // Workspace activity filters
  const [stageFilter, setStageFilter] = useState<'All' | AuditEntry['stage']>('All');
  const [activityQuery, setActivityQuery] = useState<string>('');

  const datasetScopedModifications = useMemo(() => {
    if (datasetFilter === 'ALL') return modifications;
    return modifications.filter((m) => m.datasetId === datasetFilter);
  }, [modifications, datasetFilter]);

  const availableColumns = useMemo(() => {
    const set = new Set<string>();
    for (const item of datasetScopedModifications) {
      set.add(item.columnName);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [datasetScopedModifications]);

  const availableMethods = useMemo(() => {
    const set = new Set<string>();
    for (const item of datasetScopedModifications) {
      set.add(item.repairMethod);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [datasetScopedModifications]);

  const filteredModifications = useMemo(() => {
    const q = modSearchQuery.trim().toLowerCase();
    return datasetScopedModifications.filter((rec) => {
      if (columnFilter !== 'ALL' && rec.columnName !== columnFilter) {
        return false;
      }
      if (methodFilter !== 'ALL' && rec.repairMethod !== methodFilter) {
        return false;
      }
      if (statusFilter !== 'All' && rec.validationStatus !== statusFilter) {
        return false;
      }
      if (q.length > 0) {
        const haystack = [
          `row ${rec.rowNumber}`,
          String(rec.rowNumber),
          rec.datasetName,
          rec.columnName,
          rec.originalValue,
          rec.updatedValue,
          rec.reason,
          rec.repairMethod,
          rec.timestamp,
          rec.validationStatus,
          rec.issueType,
        ]
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [
    datasetScopedModifications,
    columnFilter,
    methodFilter,
    statusFilter,
    modSearchQuery,
  ]);

  const summaryCounts = useMemo(() => {
    let confirmed = 0;
    let failed = 0;
    const touchedColumns = new Set<string>();

    for (const rec of datasetScopedModifications) {
      if (rec.validationStatus === 'Confirmed') confirmed += 1;
      if (rec.validationStatus === 'Failed') failed += 1;
      touchedColumns.add(rec.columnName);
    }

    return {
      total: datasetScopedModifications.length,
      confirmed,
      failed,
      uniqueColumns: touchedColumns.size,
    };
  }, [datasetScopedModifications]);

  const hasActiveModFilters =
    datasetFilter !== 'ALL' ||
    columnFilter !== 'ALL' ||
    methodFilter !== 'ALL' ||
    statusFilter !== 'All' ||
    modSearchQuery.trim().length > 0;

  const handleClearModFilters = () => {
    setDatasetFilter('ALL');
    onSelectDataset('ALL');
    setColumnFilter('ALL');
    setMethodFilter('ALL');
    setStatusFilter('All');
    setModSearchQuery('');
  };

  const filteredAudits = useMemo(() => {
    const q = activityQuery.trim().toLowerCase();
    return audits.filter((entry) => {
      const matchesStage = stageFilter === 'All' || entry.stage === stageFilter;
      const matchesQuery =
        q.length === 0 ||
        entry.datasetName.toLowerCase().includes(q) ||
        entry.action.toLowerCase().includes(q) ||
        entry.actor.toLowerCase().includes(q);
      return matchesStage && matchesQuery;
    });
  }, [audits, stageFilter, activityQuery]);

  const handleDownloadAuditReport = async (format: 'csv' | 'xlsx' | 'json') => {
    setDownloadingFormat(format);
    setExportError(null);
    try {
      const url = datafixApi.getAuditExportUrl({
        format,
        datasetId: datasetFilter,
        column: columnFilter,
        repairMethod: methodFilter,
        validationStatus: statusFilter,
        q: modSearchQuery,
      });
      const fallback =
        format === 'xlsx'
          ? 'datafix_modification_history.xlsx'
          : `datafix_audit_report.${format}`;
      await downloadFileFromApi(url, fallback);
      if (onAuditExported) {
        await onAuditExported();
      }
    } catch (err) {
      setExportError(
        err instanceof Error
          ? err.message
          : `Unable to download audit report (${format.toUpperCase()}).`
      );
    } finally {
      setDownloadingFormat(null);
    }
  };

  const handleExportActivityCsv = () => {
    const csv = serializeRowsToCsv(
      filteredAudits.map((a) => ({
        timestamp: a.timestamp,
        stage: a.stage,
        dataset: a.datasetName,
        action: a.action,
        actor: a.actor,
        outcome: a.outcome,
      }))
    );
    triggerTextDownload('datafix_workspace_activity.csv', `\uFEFF${csv}`);
  };

  const renderValidationStatus = (status: AuditModificationValidationStatus) => {
    switch (status) {
      case 'Confirmed':
        return (
          <span className="inline-flex items-center gap-1 font-semibold text-emerald-700 whitespace-nowrap">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
            <span>Confirmed</span>
          </span>
        );
      case 'Failed':
        return (
          <span className="inline-flex items-center gap-1 font-semibold text-red-700 whitespace-nowrap">
            <XCircle className="h-3.5 w-3.5 shrink-0" />
            <span>Failed</span>
          </span>
        );
      case 'Reverted':
        return (
          <span className="inline-flex items-center gap-1 font-semibold text-slate-500 whitespace-nowrap">
            <RotateCcw className="h-3.5 w-3.5 shrink-0" />
            <span>Reverted</span>
          </span>
        );
      case 'Pending Validation':
        return (
          <span className="inline-flex items-center gap-1 font-semibold text-amber-700 whitespace-nowrap">
            <Clock className="h-3.5 w-3.5 shrink-0" />
            <span>Pending Validation</span>
          </span>
        );
    }
  };

  return (
    <div className="space-y-6">
      {/* Page Header & Download Audit Report Controls */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[#0B192C]">
            Audit History
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Immutable audit ledger recording every approved data modification from actual repair operations, along with validation status and exportable compliance reports.
          </p>
        </div>

        <div className="flex flex-wrap sm:flex-nowrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => void handleDownloadAuditReport('xlsx')}
            disabled={filteredModifications.length === 0 || downloadingFormat !== null}
            data-testid="download-audit-xlsx-btn"
            className="inline-flex items-center gap-2 rounded-md bg-[#0284C7] px-3.5 py-2 text-sm font-medium text-white hover:bg-[#0369A1] disabled:opacity-40 whitespace-nowrap shrink-0"
          >
            {downloadingFormat === 'xlsx' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FileSpreadsheet className="h-4 w-4" />
            )}
            <span>
              {downloadingFormat === 'xlsx'
                ? 'Exporting...'
                : 'Download Excel (.xlsx)'}
            </span>
          </button>

          <button
            type="button"
            onClick={() => void handleDownloadAuditReport('csv')}
            disabled={filteredModifications.length === 0 || downloadingFormat !== null}
            data-testid="download-audit-csv-btn"
            className="inline-flex items-center gap-2 rounded-md bg-[#0B192C] px-3.5 py-2 text-sm font-medium text-white hover:bg-[#163155] disabled:opacity-40 whitespace-nowrap shrink-0"
          >
            {downloadingFormat === 'csv' ? (
              <Loader2 className="h-4 w-4 animate-spin text-[#D9B352]" />
            ) : (
              <Download className="h-4 w-4 text-[#D9B352]" />
            )}
            <span>
              {downloadingFormat === 'csv' ? 'Exporting...' : 'Download CSV'}
            </span>
          </button>

          <button
            type="button"
            onClick={() => void handleDownloadAuditReport('json')}
            disabled={filteredModifications.length === 0 || downloadingFormat !== null}
            data-testid="download-audit-json-btn"
            className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-[#0B192C] hover:bg-slate-50 disabled:opacity-40 whitespace-nowrap shrink-0"
          >
            {downloadingFormat === 'json' ? (
              <Loader2 className="h-4 w-4 animate-spin text-[#0284C7]" />
            ) : (
              <FileJson className="h-4 w-4 text-[#0284C7]" />
            )}
            <span>{downloadingFormat === 'json' ? 'Exporting...' : 'JSON'}</span>
          </button>
        </div>
      </div>

      {exportError && (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          <AlertCircle className="h-4 w-4 mt-0.5 text-red-700 shrink-0" />
          <span>{exportError}</span>
        </div>
      )}

      {/* 4 Audit Summary KPI Cards */}
      <section
        aria-label="Audit modification summary"
        className="grid grid-cols-2 gap-4 lg:grid-cols-4"
      >
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <p className="text-xs font-medium text-slate-500">
            Approved Modifications
          </p>
          <p
            data-testid="audit-total-modifications"
            className="mt-2 font-mono text-2xl font-semibold tabular-nums text-[#0B192C]"
          >
            {summaryCounts.total.toLocaleString()}
          </p>
          <p className="mt-1 text-[11px] text-slate-500">
            Recorded from actual repairs
          </p>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <p className="text-xs font-medium text-slate-500">
            Validation Confirmed
          </p>
          <p
            data-testid="audit-confirmed-count"
            className="mt-2 font-mono text-2xl font-semibold tabular-nums text-emerald-700"
          >
            {summaryCounts.confirmed.toLocaleString()}
          </p>
          <p className="mt-1 text-[11px] text-emerald-700/90 font-medium">
            Verified by validation engine
          </p>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <p className="text-xs font-medium text-slate-500">
            Failed Validation
          </p>
          <p
            data-testid="audit-failed-count"
            className={`mt-2 font-mono text-2xl font-semibold tabular-nums ${
              summaryCounts.failed > 0 ? 'text-red-700' : 'text-[#0B192C]'
            }`}
          >
            {summaryCounts.failed.toLocaleString()}
          </p>
          <p className="mt-1 text-[11px] text-slate-500">
            {summaryCounts.failed > 0
              ? 'Requires review in Repair Data'
              : 'Zero failed verifications'}
          </p>
        </div>

        <div className="rounded-lg border border-[#D9B352]/65 bg-white p-4">
          <p className="text-xs font-medium text-slate-500">
            Columns Audited
          </p>
          <p
            data-testid="audit-columns-count"
            className="mt-2 font-mono text-2xl font-semibold tabular-nums text-[#0B192C]"
          >
            {summaryCounts.uniqueColumns.toLocaleString()}
          </p>
          <p className="mt-1 text-[11px] text-[#8F6A14]">
            Original dataset preserved
          </p>
        </div>
      </section>

      {/* Tab Switcher: Approved Modifications vs. Workspace Activity Log */}
      <section className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-slate-200 px-5 py-3.5">
          <div className="flex max-w-full items-center gap-1 overflow-x-auto rounded-md bg-slate-100 p-1 self-start">
            <button
              type="button"
              onClick={() => setActiveTab('modifications')}
              data-testid="audit-tab-modifications"
              className={`rounded px-2.5 sm:px-3 py-1.5 text-xs font-semibold whitespace-nowrap shrink-0 transition-colors ${
                activeTab === 'modifications'
                  ? 'bg-white text-[#0B192C] shadow-xs'
                  : 'text-slate-600 hover:text-[#0B192C]'
              }`}
            >
              Approved Modifications ({modifications.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('activity')}
              data-testid="audit-tab-activity"
              className={`rounded px-2.5 sm:px-3 py-1.5 text-xs font-semibold whitespace-nowrap shrink-0 transition-colors ${
                activeTab === 'activity'
                  ? 'bg-white text-[#0B192C] shadow-xs'
                  : 'text-slate-600 hover:text-[#0B192C]'
              }`}
            >
              Activity Log ({audits.length})
            </button>
          </div>

          {activeTab === 'modifications' ? (
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <ShieldCheck
                aria-hidden="true"
                className="h-4 w-4 text-[#0284C7] shrink-0"
              />
              <span>
                Showing{' '}
                <span className="font-mono font-semibold tabular-nums text-[#0B192C]">
                  {filteredModifications.length}
                </span>{' '}
                of{' '}
                <span className="font-mono font-semibold tabular-nums text-[#0B192C]">
                  {modifications.length}
                </span>{' '}
                approved modifications
              </span>
            </div>
          ) : (
            <button
              type="button"
              onClick={handleExportActivityCsv}
              disabled={filteredAudits.length === 0}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-[#0B192C] hover:bg-slate-50 disabled:opacity-40 whitespace-nowrap self-start sm:self-auto"
            >
              <Download className="h-3.5 w-3.5 text-[#0284C7]" />
              <span>Export Activity CSV</span>
            </button>
          )}
        </div>

        {activeTab === 'modifications' ? (
          <>
            {/* Multi-Facet Modification Filter Bar */}
            <div className="space-y-3 border-b border-slate-200 bg-slate-50/50 px-5 py-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <div className="relative">
                  <Search
                    aria-hidden="true"
                    className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
                  />
                  <label htmlFor="audit-mod-search" className="sr-only">
                    Search approved modifications
                  </label>
                  <input
                    id="audit-mod-search"
                    type="search"
                    value={modSearchQuery}
                    onChange={(e) => setModSearchQuery(e.target.value)}
                    placeholder="Search row, column, value, reason..."
                    data-testid="audit-search-input"
                    className="w-full rounded-md border border-slate-200 bg-white py-2 pl-8 pr-3 text-xs text-[#0B192C] placeholder:text-slate-400 focus:border-[#0284C7] focus:outline-none focus:ring-2 focus:ring-[#0284C7]/20"
                  />
                </div>

                <div>
                  <label htmlFor="audit-dataset-filter" className="sr-only">
                    Filter by dataset
                  </label>
                  <select
                    id="audit-dataset-filter"
                    value={datasetFilter}
                    onChange={(e) => {
                      const val = e.target.value;
                      setDatasetFilter(val);
                      onSelectDataset(val);
                      setColumnFilter('ALL');
                      setMethodFilter('ALL');
                    }}
                    data-testid="audit-dataset-filter"
                    className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-[#0B192C] focus:border-[#0284C7] focus:outline-none focus:ring-2 focus:ring-[#0284C7]/20"
                  >
                    <option value="ALL">All Datasets ({datasets.length})</option>
                    {datasets.map((ds) => (
                      <option key={ds.id} value={ds.id}>
                        {ds.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="audit-column-filter" className="sr-only">
                    Filter by column name
                  </label>
                  <select
                    id="audit-column-filter"
                    value={columnFilter}
                    onChange={(e) => setColumnFilter(e.target.value)}
                    data-testid="audit-column-filter"
                    className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-[#0B192C] focus:border-[#0284C7] focus:outline-none focus:ring-2 focus:ring-[#0284C7]/20"
                  >
                    <option value="ALL">
                      All Columns ({availableColumns.length})
                    </option>
                    {availableColumns.map((col) => (
                      <option key={col} value={col}>
                        {col}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="audit-method-filter" className="sr-only">
                    Filter by repair method
                  </label>
                  <select
                    id="audit-method-filter"
                    value={methodFilter}
                    onChange={(e) => setMethodFilter(e.target.value)}
                    data-testid="audit-method-filter"
                    className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-[#0B192C] focus:border-[#0284C7] focus:outline-none focus:ring-2 focus:ring-[#0284C7]/20"
                  >
                    <option value="ALL">
                      All Repair Methods ({availableMethods.length})
                    </option>
                    {availableMethods.map((method) => (
                      <option key={method} value={method}>
                        {method}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <div
                  role="group"
                  aria-label="Filter modifications by validation status"
                  className="flex items-center gap-1 overflow-x-auto rounded-md bg-slate-200/70 p-1"
                >
                  {STATUS_FILTERS.map((status) => (
                    <button
                      key={status}
                      type="button"
                      onClick={() => setStatusFilter(status)}
                      className={`rounded px-2.5 py-1 text-xs font-medium whitespace-nowrap shrink-0 transition-colors ${
                        statusFilter === status
                          ? 'bg-white text-[#0B192C] shadow-xs'
                          : 'text-slate-600 hover:text-[#0B192C]'
                      }`}
                    >
                      {status}
                    </button>
                  ))}
                </div>

                {hasActiveModFilters && (
                  <button
                    type="button"
                    onClick={handleClearModFilters}
                    data-testid="audit-clear-filters-btn"
                    className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                  >
                    <FilterX className="h-3.5 w-3.5 text-slate-500" />
                    <span>Clear Filters</span>
                  </button>
                )}
              </div>
            </div>

            {/* Approved Modifications Audit History Table (All 8 Required Fields) */}
            <div className="w-full overflow-x-auto">
              <table
                className="w-full min-w-[1060px] border-collapse text-left text-xs"
                data-testid="audit-modifications-table"
              >
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    <th className="py-3 pl-5 pr-3 whitespace-nowrap">Row #</th>
                    <th className="px-3 py-3 whitespace-nowrap">Column Name</th>
                    <th className="px-3 py-3 whitespace-nowrap">Original Value</th>
                    <th className="px-3 py-3 whitespace-nowrap">Updated Value</th>
                    <th className="px-3 py-3">Reason for Modification</th>
                    <th className="px-3 py-3 whitespace-nowrap">Repair Method</th>
                    <th className="px-3 py-3 whitespace-nowrap">Timestamp</th>
                    <th className="py-3 pl-3 pr-5 whitespace-nowrap">
                      Validation Status
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredModifications.length === 0 ? (
                    <tr>
                      <td
                        colSpan={8}
                        className="py-12 px-5 text-center text-sm text-slate-500"
                      >
                        {modifications.length === 0 ? (
                          <div className="flex flex-col items-center gap-3">
                            <p className="max-w-lg text-slate-600">
                              No approved data modifications have been recorded yet. Audit entries are generated automatically from actual approved repair operations.
                            </p>
                            {onNavigate && (
                              <button
                                type="button"
                                onClick={() => onNavigate('repair')}
                                className="inline-flex items-center gap-1.5 rounded-md bg-[#0B192C] px-4 py-2 text-xs font-medium text-white hover:bg-[#163155]"
                              >
                                <span>Go to Repair Data to Approve Repairs</span>
                                <ArrowRight className="h-3.5 w-3.5 text-[#D9B352]" />
                              </button>
                            )}
                          </div>
                        ) : (
                          'No modification records match the active filters.'
                        )}
                      </td>
                    </tr>
                  ) : (
                    filteredModifications.map((rec) => (
                      <tr
                        key={rec.id}
                        data-testid="audit-modification-row"
                        className={`align-top transition-colors ${
                          rec.validationStatus === 'Failed'
                            ? 'bg-red-50/40 hover:bg-red-50/70'
                            : rec.validationStatus === 'Reverted'
                              ? 'bg-slate-50/60 hover:bg-slate-100/60'
                              : 'hover:bg-[#EBF5FC]/40'
                        }`}
                      >
                        <td className="py-3.5 pl-5 pr-3 font-mono font-semibold tabular-nums text-[#0B192C] whitespace-nowrap">
                          Row {rec.rowNumber}
                        </td>
                        <td className="px-3 py-3.5 whitespace-nowrap">
                          <div className="font-mono font-semibold text-[#0284C7]">
                            {rec.columnName}
                          </div>
                          {datasetFilter === 'ALL' && (
                            <div className="mt-0.5 font-mono text-[11px] text-slate-400">
                              {rec.datasetName}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-3.5 font-mono tabular-nums text-red-700 max-w-[160px] break-words whitespace-pre-wrap">
                          {formatCellValue(rec.originalValue)}
                        </td>
                        <td className="px-3 py-3.5 font-mono font-semibold tabular-nums text-emerald-700 max-w-[180px] break-words">
                          {rec.updatedValue}
                        </td>
                        <td className="px-3 py-3.5 text-slate-700 leading-relaxed max-w-[270px]">
                          {rec.reason}
                        </td>
                        <td className="px-3 py-3.5 whitespace-nowrap font-medium text-[#0B192C]">
                          {rec.repairMethod}
                        </td>
                        <td className="px-3 py-3.5 font-mono tabular-nums text-slate-500 whitespace-nowrap">
                          {rec.timestamp}
                        </td>
                        <td className="py-3.5 pl-3 pr-5">
                          {renderValidationStatus(rec.validationStatus)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <>
            {/* Workspace Activity Log Filter Bar */}
            <div className="flex flex-col gap-3 border-b border-slate-200 p-5 lg:flex-row lg:items-center lg:justify-between">
              <div className="relative">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                />
                <label htmlFor="audit-activity-search" className="sr-only">
                  Search workspace activity log
                </label>
                <input
                  id="audit-activity-search"
                  type="search"
                  value={activityQuery}
                  onChange={(e) => setActivityQuery(e.target.value)}
                  placeholder="Search dataset or action..."
                  className="w-full sm:w-64 rounded-md border border-slate-200 bg-slate-50 py-1.5 pl-9 pr-3 text-sm text-[#0B192C] placeholder:text-slate-400 focus:border-[#0284C7] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0284C7]/20"
                />
              </div>

              <div
                role="group"
                aria-label="Filter audit events by stage"
                className="flex items-center gap-1 overflow-x-auto rounded-md bg-slate-100 p-1"
              >
                {ACTIVITY_STAGES.map((stage) => (
                  <button
                    key={stage}
                    type="button"
                    onClick={() => setStageFilter(stage)}
                    className={`rounded px-2.5 py-1 text-xs font-medium whitespace-nowrap shrink-0 transition-colors ${
                      stageFilter === stage
                        ? 'bg-white text-[#0B192C] shadow-xs'
                        : 'text-slate-600 hover:text-[#0B192C]'
                    }`}
                  >
                    {stage}
                  </button>
                ))}
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[740px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    <th className="py-3 pl-5 pr-3">Timestamp</th>
                    <th className="px-3 py-3">Stage</th>
                    <th className="px-3 py-3">Dataset</th>
                    <th className="px-3 py-3">Action Summary</th>
                    <th className="px-3 py-3">Actor</th>
                    <th className="py-3 pl-3 pr-5">Outcome</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredAudits.length === 0 ? (
                    <tr>
                      <td
                        colSpan={6}
                        className="py-10 text-center text-sm text-slate-500"
                      >
                        No workspace activity records match your current filter.
                      </td>
                    </tr>
                  ) : (
                    filteredAudits.map((entry) => (
                      <tr key={entry.id} className="h-11 hover:bg-[#EBF5FC]/40">
                        <td className="py-3 pl-5 pr-3 font-mono text-xs tabular-nums text-slate-600 whitespace-nowrap">
                          {entry.timestamp}
                        </td>
                        <td className="px-3 py-3 font-medium text-[#0B192C]">
                          {entry.stage}
                        </td>
                        <td className="px-3 py-3 font-mono text-xs text-slate-700">
                          {entry.datasetName}
                        </td>
                        <td className="px-3 py-3 text-slate-700">
                          {entry.action}
                        </td>
                        <td className="px-3 py-3 text-xs text-slate-500">
                          {entry.actor}
                        </td>
                        <td className="py-3 pl-3 pr-5 text-xs font-semibold">
                          <span
                            className={
                              entry.outcome === 'Completed'
                                ? 'text-emerald-700'
                                : entry.outcome === 'Flagged'
                                  ? 'text-amber-700'
                                  : 'text-[#0284C7]'
                            }
                          >
                            {entry.outcome}
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
