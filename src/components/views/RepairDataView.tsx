import {
  AlertTriangle,
  ArrowRight,
  Check,
  History,
  Loader2,
  RotateCcw,
  Search,
  ShieldCheck,
  Table2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { datafixApi } from '../../services/api';
import type {
  ApproveRepairSelection,
  DatasetRecord,
  DetectionIssueType,
  ModificationHistoryEntry,
  NavSectionId,
  RepairConfidenceLevel,
  RepairSuggestion,
} from '../../types/datafix';

interface RepairDataViewProps {
  datasets: DatasetRecord[];
  selectedDatasetId: string;
  onSelectDataset: (id: string) => void;
  suggestions: RepairSuggestion[];
  modificationHistory: ModificationHistoryEntry[];
  onRepairsUpdated: () => Promise<void> | void;
  onNavigate: (section: NavSectionId) => void;
}

type ReviewModeFilter = 'All' | 'Actionable' | 'Manual Review';
type BottomTab = 'history' | 'preview';
type PreviewVersion = 'current' | 'original';

const CATEGORY_ORDER: DetectionIssueType[] = [
  'Missing Values',
  'Duplicate Records',
  'Invalid Formats',
  'Inconsistent Values',
  'Anomalies',
];

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

function confidenceTextClass(level: RepairConfidenceLevel): string {
  switch (level) {
    case 'High':
      return 'text-emerald-700';
    case 'Medium':
      return 'text-[#A17816]';
    case 'Low':
      return 'text-amber-700';
  }
}

function formatCellDisplay(value: string): string {
  if (value !== value.trim()) {
    return `"${value}"`;
  }
  return value;
}

export function RepairDataView({
  datasets,
  selectedDatasetId,
  onSelectDataset,
  suggestions,
  modificationHistory,
  onRepairsUpdated,
  onNavigate,
}: RepairDataViewProps) {
  const effectiveDatasetId =
    selectedDatasetId && selectedDatasetId !== 'ALL'
      ? selectedDatasetId
      : datasets[0]?.id ?? '';

  const activeDataset = useMemo(
    () => datasets.find((d) => d.id === effectiveDatasetId) ?? null,
    [datasets, effectiveDatasetId]
  );

  const datasetSuggestions = useMemo(
    () => suggestions.filter((s) => s.datasetId === effectiveDatasetId),
    [suggestions, effectiveDatasetId]
  );

  const datasetHistory = useMemo(
    () => modificationHistory.filter((h) => h.datasetId === effectiveDatasetId),
    [modificationHistory, effectiveDatasetId]
  );

  const suggestionCountByDataset = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of suggestions) {
      map.set(s.datasetId, (map.get(s.datasetId) ?? 0) + 1);
    }
    return map;
  }, [suggestions]);

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [imputationChoices, setImputationChoices] = useState<
    Record<string, 'mean' | 'median'>
  >({});
  const [categoryFilter, setCategoryFilter] = useState<'All' | DetectionIssueType>('All');
  const [reviewMode, setReviewMode] = useState<ReviewModeFilter>('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [bottomTab, setBottomTab] = useState<BottomTab>('history');
  const [previewVersion, setPreviewVersion] = useState<PreviewVersion>('current');

  const [applying, setApplying] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const actionableSuggestions = useMemo(
    () => datasetSuggestions.filter((s) => !s.manualReviewOnly),
    [datasetSuggestions]
  );
  const manualReviewSuggestions = useMemo(
    () => datasetSuggestions.filter((s) => s.manualReviewOnly),
    [datasetSuggestions]
  );

  const suggestionIdsSignature = useMemo(
    () => datasetSuggestions.map((s) => s.id).join('|'),
    [datasetSuggestions]
  );

  // Sync default selections and imputation choices whenever dataset or suggestion list changes
  useEffect(() => {
    setSelectedIds(actionableSuggestions.map((s) => s.id));
    const defaults: Record<string, 'mean' | 'median'> = {};
    for (const s of datasetSuggestions) {
      if (s.imputationOptions) {
        defaults[s.id] = s.imputationOptions.defaultMethod;
      }
    }
    setImputationChoices(defaults);
    setErrorMessage(null);
  }, [effectiveDatasetId, suggestionIdsSignature]);

  const countsByCategory = useMemo(() => {
    const counts: Record<DetectionIssueType, number> = {
      'Missing Values': 0,
      'Duplicate Records': 0,
      'Invalid Formats': 0,
      'Inconsistent Values': 0,
      Anomalies: 0,
    };
    for (const item of datasetSuggestions) {
      counts[item.issueType] += 1;
    }
    return counts;
  }, [datasetSuggestions]);

  const filteredSuggestions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return datasetSuggestions.filter((item) => {
      if (categoryFilter !== 'All' && item.issueType !== categoryFilter) {
        return false;
      }
      if (reviewMode === 'Actionable' && item.manualReviewOnly) {
        return false;
      }
      if (reviewMode === 'Manual Review' && !item.manualReviewOnly) {
        return false;
      }
      if (q.length > 0) {
        return (
          item.column.toLowerCase().includes(q) ||
          item.originalValue.toLowerCase().includes(q) ||
          item.proposedValue.toLowerCase().includes(q) ||
          item.reason.toLowerCase().includes(q) ||
          item.repairMethod.toLowerCase().includes(q) ||
          item.issueType.toLowerCase().includes(q) ||
          `row ${item.rowNumber}`.includes(q)
        );
      }
      return true;
    });
  }, [datasetSuggestions, categoryFilter, reviewMode, searchQuery]);

  const validSelectedIds = useMemo(
    () =>
      selectedIds.filter((id) =>
        actionableSuggestions.some((s) => s.id === id)
      ),
    [selectedIds, actionableSuggestions]
  );

  const toggleSuggestion = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const handleSelectAllActionable = () => {
    setSelectedIds(actionableSuggestions.map((s) => s.id));
    setNotice(null);
  };

  const handleCancelRepairs = () => {
    setSelectedIds([]);
    const defaults: Record<string, 'mean' | 'median'> = {};
    for (const s of datasetSuggestions) {
      if (s.imputationOptions) {
        defaults[s.id] = s.imputationOptions.defaultMethod;
      }
    }
    setImputationChoices(defaults);
    setErrorMessage(null);
    setNotice(
      'Cancelled pending repair selections. No changes were applied and the original dataset remains unmodified.'
    );
  };

  const handleApproveRepairs = async () => {
    if (!effectiveDatasetId || validSelectedIds.length === 0) return;
    setApplying(true);
    setNotice(null);
    setErrorMessage(null);
    try {
      const approvals: ApproveRepairSelection[] = validSelectedIds.map((id) => ({
        suggestionId: id,
        imputationMethod: imputationChoices[id],
      }));
      if (selectedDatasetId === 'ALL') {
        onSelectDataset(effectiveDatasetId);
      }
      const result = await datafixApi.approveRepairs(effectiveDatasetId, approvals);
      await onRepairsUpdated();
      const vr = result.validationReport;
      const deltaSign = vr.qualityScoreImprovement >= 0 ? '+' : '';
      setNotice(
        `Validation engine re-analyzed ${result.dataset.name} and confirmed ${vr.issuesSuccessfullyRepaired} repaired ${
          vr.issuesSuccessfullyRepaired === 1 ? 'issue' : 'issues'
        }${
          vr.failedRepairs > 0
            ? ` (${vr.failedRepairs} failed validation)`
            : ''
        }, with ${vr.remainingIssues} remaining. Original dataset preserved; quality score moved from ${vr.originalQualityScore.toFixed(1)}% to ${vr.updatedQualityScore.toFixed(1)}% (${deltaSign}${vr.qualityScoreImprovement.toFixed(1)}%).`
      );
      setBottomTab('history');
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Unable to apply approved repairs.'
      );
    } finally {
      setApplying(false);
    }
  };

  const handleResetOriginal = async () => {
    if (!effectiveDatasetId) return;
    setResetting(true);
    setNotice(null);
    setErrorMessage(null);
    try {
      const result = await datafixApi.resetDataset(effectiveDatasetId);
      setNotice(
        `Restored ${result.dataset.name} back to the preserved original uploaded records (${result.dataset.rows} rows).`
      );
      await onRepairsUpdated();
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Unable to restore original dataset.'
      );
    } finally {
      setResetting(false);
    }
  };

  const previewRows =
    previewVersion === 'original' && activeDataset?.originalPreviewRows
      ? activeDataset.originalPreviewRows
      : activeDataset?.previewRows ?? [];

  return (
    <div className="space-y-6">
      {/* Header & Approval Buttons */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[#0B192C]">
            Repair Data
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Review proposed repairs across missing values, duplicates, formats, categories, and anomalies. Only approved changes are applied while preserving the original dataset.
          </p>
        </div>

        <div className="flex flex-wrap sm:flex-nowrap items-center gap-2 shrink-0">
          <button
            type="button"
            disabled={applying || validSelectedIds.length === 0}
            onClick={handleApproveRepairs}
            data-testid="approve-repairs-btn"
            className="inline-flex items-center gap-2 rounded-md bg-[#0B192C] px-4 py-2 text-sm font-medium text-white hover:bg-[#163155] disabled:opacity-40 whitespace-nowrap shrink-0"
          >
            {applying ? (
              <Loader2 className="h-4 w-4 animate-spin text-[#D9B352]" />
            ) : (
              <Check className="h-4 w-4 text-[#D9B352]" />
            )}
            <span>
              {applying
                ? 'Applying Repairs...'
                : `Approve Repairs (${validSelectedIds.length})`}
            </span>
          </button>

          <button
            type="button"
            disabled={applying || validSelectedIds.length === 0}
            onClick={handleCancelRepairs}
            data-testid="cancel-repairs-btn"
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 whitespace-nowrap shrink-0"
          >
            <X className="h-4 w-4 text-slate-500" />
            <span>Cancel Repairs</span>
          </button>

          {activeDataset && activeDataset.repairedCells > 0 && (
            <button
              type="button"
              disabled={resetting || applying}
              onClick={handleResetOriginal}
              data-testid="restore-original-btn"
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 whitespace-nowrap shrink-0"
            >
              {resetting ? (
                <Loader2 className="h-4 w-4 animate-spin text-[#0284C7]" />
              ) : (
                <RotateCcw className="h-4 w-4 text-[#0284C7]" />
              )}
              <span>{resetting ? 'Restoring...' : 'Restore Original'}</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => onNavigate('validation')}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-[#0B192C] hover:bg-slate-50 whitespace-nowrap shrink-0"
          >
            <span>Validation</span>
            <ArrowRight className="h-4 w-4 text-[#0284C7]" />
          </button>
        </div>
      </div>

      {/* Dataset Selector & KPI Strip */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="lg:col-span-5 rounded-lg border border-slate-200 bg-white p-4">
          <label
            htmlFor="repair-dataset-select"
            className="block text-xs font-medium text-slate-500"
          >
            Target Dataset
          </label>
          <select
            id="repair-dataset-select"
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
                {ds.name} ({suggestionCountByDataset.get(ds.id) ?? 0} suggestions)
              </option>
            ))}
          </select>
        </div>

        <div className="lg:col-span-3 rounded-lg border border-slate-200 bg-white p-4">
          <p className="text-xs font-medium text-slate-500">Actionable Repairs</p>
          <p
            className="mt-1.5 font-mono text-2xl font-semibold tabular-nums text-[#0284C7]"
            data-testid="repair-actionable-count"
          >
            {actionableSuggestions.length.toLocaleString()}
            <span className="ml-2 font-sans text-xs font-semibold text-slate-600">
              {validSelectedIds.length} selected
            </span>
          </p>
        </div>

        <div className="lg:col-span-2 rounded-lg border border-slate-200 bg-white p-4">
          <p className="text-xs font-medium text-slate-500">Manual Review</p>
          <p
            className="mt-1.5 font-mono text-2xl font-semibold tabular-nums text-amber-700"
            data-testid="repair-manual-count"
          >
            {manualReviewSuggestions.length.toLocaleString()}
          </p>
        </div>

        <div className="lg:col-span-2 rounded-lg border border-[#D9B352]/60 bg-white p-4">
          <p className="text-xs font-medium text-slate-500">Quality Score</p>
          <p
            className="mt-1.5 font-mono text-2xl font-semibold tabular-nums text-[#0B192C]"
            data-testid="repair-quality-score"
          >
            {(activeDataset?.qualityScore ?? 0).toFixed(1)}%
          </p>
        </div>
      </div>

      {/* 5 Repair Category Filter Cards */}
      <section
        aria-label="Repair category breakdown"
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5"
      >
        {CATEGORY_ORDER.map((category) => {
          const active = categoryFilter === category;
          const count = countsByCategory[category];
          return (
            <button
              key={category}
              type="button"
              onClick={() =>
                setCategoryFilter((prev) => (prev === category ? 'All' : category))
              }
              className={`rounded-lg border p-3.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0284C7] ${
                active
                  ? 'border-[#0284C7] bg-[#EBF5FC]/55'
                  : 'border-slate-200 bg-white hover:border-slate-300'
              }`}
            >
              <p className="text-xs font-medium text-slate-500 truncate">{category}</p>
              <p
                className={`mt-1 font-mono text-xl font-semibold tabular-nums ${issueTypeTextClass(
                  category
                )}`}
              >
                {count.toLocaleString()}
              </p>
            </button>
          );
        })}
      </section>

      {/* Safeguard Bar */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between rounded-lg border border-slate-200 bg-white px-4 py-3 text-xs text-slate-600">
        <div className="flex items-start sm:items-center gap-2.5">
          <ShieldCheck
            aria-hidden="true"
            className="h-4 w-4 text-[#0284C7] shrink-0 mt-0.5 sm:mt-0"
          />
          <p>
            <span className="font-semibold text-[#0B192C]">Original Dataset Preserved:</span>{' '}
            No missing personal information is invented. Anomalies and sensitive fields are highlighted for manual review and never auto-modified.
          </p>
        </div>
        <span className="font-mono text-[11px] tabular-nums text-slate-500 whitespace-nowrap shrink-0">
          {datasetHistory.length} modification {datasetHistory.length === 1 ? 'entry' : 'entries'} logged
        </span>
      </div>

      {(applying || resetting) && (
        <div
          role="status"
          aria-live="polite"
          data-testid="repair-loading-banner"
          className="flex items-center gap-2.5 rounded-lg border border-sky-200 bg-[#EBF5FC] px-4 py-3 text-sm text-[#0B192C]"
        >
          <Loader2
            aria-hidden="true"
            className="h-4 w-4 animate-spin text-[#0284C7] shrink-0"
          />
          <span>
            {applying
              ? 'Applying approved repairs, running post-repair validation, and recording changes to Audit History...'
              : 'Restoring preserved original dataset baseline and re-running quality analysis...'}
          </span>
        </div>
      )}

      {notice && (
        <div
          role="status"
          data-testid="repair-notice-banner"
          className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between rounded-lg border border-emerald-200 bg-emerald-50/80 px-4 py-3 text-sm text-emerald-900"
        >
          <span>{notice}</span>
          {activeDataset && activeDataset.repairedCells > 0 && (
            <button
              type="button"
              onClick={() => onNavigate('validation')}
              data-testid="proceed-to-validation-btn"
              className="inline-flex items-center gap-1.5 rounded-md bg-[#0B192C] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#163155] whitespace-nowrap shrink-0 self-start sm:self-center"
            >
              <span>Proceed to Validation</span>
              <ArrowRight className="h-3.5 w-3.5 text-[#D9B352]" />
            </button>
          )}
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

      {/* Repair Suggestion Table */}
      <section
        aria-label="Repair suggestion table"
        className="rounded-lg border border-slate-200 bg-white overflow-hidden"
      >
        <div className="flex flex-col gap-3 border-b border-slate-200 px-5 py-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-[#0B192C]">
              Repair Suggestion Table
            </h2>
            <p className="text-xs text-slate-500 truncate">
              Select the specific repairs you approve for{' '}
              <span className="font-mono text-[#0B192C]">
                {activeDataset?.name ?? 'selected dataset'}
              </span>
            </p>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap xl:flex-nowrap sm:items-center shrink-0">
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
              />
              <label htmlFor="repair-search" className="sr-only">
                Search repair suggestions
              </label>
              <input
                id="repair-search"
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search column, row, or method..."
                className="w-full sm:w-48 rounded-md border border-slate-200 bg-slate-50 py-1.5 pl-8 pr-3 text-xs text-[#0B192C] placeholder:text-slate-400 focus:border-[#0284C7] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0284C7]/20"
              />
            </div>

            {actionableSuggestions.length > 0 && (
              <button
                type="button"
                onClick={
                  validSelectedIds.length === actionableSuggestions.length
                    ? () => setSelectedIds([])
                    : handleSelectAllActionable
                }
                className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-medium text-[#0B192C] hover:bg-slate-100 whitespace-nowrap"
              >
                {validSelectedIds.length === actionableSuggestions.length
                  ? 'Unselect All'
                  : 'Select All Actionable'}
              </button>
            )}

            <div
              role="group"
              aria-label="Filter repair suggestions by review mode"
              className="flex items-center gap-1 rounded-md bg-slate-100 p-1 self-start sm:self-auto"
            >
              {(['All', 'Actionable', 'Manual Review'] as ReviewModeFilter[]).map(
                (mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setReviewMode(mode)}
                    className={`rounded px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors ${
                      reviewMode === mode
                        ? 'bg-white text-[#0B192C] shadow-xs'
                        : 'text-slate-600 hover:text-[#0B192C]'
                    }`}
                  >
                    {mode}
                  </button>
                )
              )}
            </div>
          </div>
        </div>

        <div className="w-full overflow-x-auto">
          <table
            className="w-full min-w-[1020px] border-collapse text-left text-xs"
            data-testid="repair-suggestions-table"
          >
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                <th className="py-3 pl-5 pr-2 w-12">Approve</th>
                <th className="px-3 py-3 whitespace-nowrap">Row & Column</th>
                <th className="px-3 py-3 whitespace-nowrap">Original Value</th>
                <th className="px-3 py-3 whitespace-nowrap">Proposed Value</th>
                <th className="px-3 py-3">Reason for Change</th>
                <th className="px-3 py-3 whitespace-nowrap">Repair Method</th>
                <th className="py-3 pl-3 pr-5 whitespace-nowrap">Confidence Level</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredSuggestions.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-sm text-slate-500">
                    {datasetSuggestions.length === 0
                      ? 'No pending repair suggestions — all actionable issues in this dataset have been resolved.'
                      : 'No repair suggestions match the active category or search filters.'}
                  </td>
                </tr>
              ) : (
                filteredSuggestions.map((item) => {
                  const isChecked = validSelectedIds.includes(item.id);
                  const chosenImputation =
                    imputationChoices[item.id] ??
                    item.imputationOptions?.defaultMethod ??
                    'median';

                  const displayedProposedValue = item.imputationOptions
                    ? String(
                        chosenImputation === 'mean'
                          ? item.imputationOptions.meanValue
                          : item.imputationOptions.medianValue
                      )
                    : item.proposedValue;

                  const displayedMethod = item.imputationOptions
                    ? chosenImputation === 'mean'
                      ? 'Mean Imputation'
                      : 'Median Imputation'
                    : item.repairMethod;

                  const isEmptyOriginal = item.originalValue === '(empty)';

                  return (
                    <tr
                      key={item.id}
                      data-testid="repair-suggestion-row"
                      className={`align-top transition-colors ${
                        item.manualReviewOnly
                          ? 'bg-amber-50/45 hover:bg-amber-50/75'
                          : 'hover:bg-[#EBF5FC]/40'
                      }`}
                    >
                      <td className="py-3.5 pl-5 pr-2">
                        {item.manualReviewOnly ? (
                          <span
                            title="Manual review required — cannot be auto-applied"
                            className="inline-flex h-5 w-5 items-center justify-center text-amber-700"
                          >
                            <AlertTriangle className="h-4 w-4" aria-label="Manual review only" />
                          </span>
                        ) : (
                          <input
                            type="checkbox"
                            aria-label={`Approve repair for Row ${item.rowNumber} column ${item.column}`}
                            checked={isChecked}
                            onChange={() => toggleSuggestion(item.id)}
                            className="mt-0.5 h-4 w-4 rounded border-slate-300 text-[#0284C7] focus:ring-[#0284C7]"
                          />
                        )}
                      </td>

                      <td className="px-3 py-3.5 whitespace-nowrap">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono font-semibold tabular-nums text-[#0B192C]">
                            Row {item.rowNumber}
                          </span>
                          <span aria-hidden="true" className="text-slate-300">
                            ·
                          </span>
                          <span className="font-mono font-semibold text-[#0284C7]">
                            {item.column}
                          </span>
                        </div>
                        <div
                          className={`mt-0.5 text-[11px] font-semibold ${issueTypeTextClass(
                            item.issueType
                          )}`}
                        >
                          {item.issueType}
                        </div>
                      </td>

                      <td className="px-3 py-3.5 font-mono tabular-nums max-w-[165px] break-words">
                        <span
                          className={`whitespace-pre-wrap ${
                            isEmptyOriginal
                              ? 'italic text-amber-700'
                              : item.manualReviewOnly
                                ? 'font-semibold text-amber-900'
                                : 'text-red-700'
                          }`}
                        >
                          {formatCellDisplay(item.originalValue)}
                        </span>
                      </td>

                      <td className="px-3 py-3.5 max-w-[215px]">
                        {item.manualReviewOnly ? (
                          <span className="font-semibold text-amber-800">
                            {displayedProposedValue}
                          </span>
                        ) : item.operationType === 'remove_duplicate_row' ? (
                          <span className="font-medium text-red-700">
                            {displayedProposedValue}
                          </span>
                        ) : (
                          <span className="font-mono font-semibold tabular-nums text-emerald-700 break-words">
                            {displayedProposedValue}
                          </span>
                        )}

                        {item.imputationOptions && (
                          <div
                            role="group"
                            aria-label={`Choose mean or median imputation for Row ${item.rowNumber} ${item.column}`}
                            className="mt-2 inline-flex items-center gap-1 rounded bg-slate-100 p-0.5"
                          >
                            <button
                              type="button"
                              onClick={() =>
                                setImputationChoices((prev) => ({
                                  ...prev,
                                  [item.id]: 'mean',
                                }))
                              }
                              className={`rounded px-2 py-0.5 font-mono text-[11px] tabular-nums transition-colors ${
                                chosenImputation === 'mean'
                                  ? 'bg-white font-semibold text-[#0B192C] shadow-xs'
                                  : 'text-slate-600 hover:text-[#0B192C]'
                              }`}
                            >
                              Mean ({item.imputationOptions.meanValue})
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                setImputationChoices((prev) => ({
                                  ...prev,
                                  [item.id]: 'median',
                                }))
                              }
                              className={`rounded px-2 py-0.5 font-mono text-[11px] tabular-nums transition-colors ${
                                chosenImputation === 'median'
                                  ? 'bg-white font-semibold text-[#0B192C] shadow-xs'
                                  : 'text-slate-600 hover:text-[#0B192C]'
                              }`}
                            >
                              Median ({item.imputationOptions.medianValue})
                            </button>
                          </div>
                        )}
                      </td>

                      <td className="px-3 py-3.5 text-slate-700 leading-relaxed max-w-[290px]">
                        {item.reason}
                      </td>

                      <td className="px-3 py-3.5 whitespace-nowrap font-medium text-[#0B192C]">
                        {displayedMethod}
                      </td>

                      <td className="py-3.5 pl-3 pr-5 whitespace-nowrap">
                        <span
                          className={`font-semibold ${confidenceTextClass(
                            item.confidenceLevel
                          )}`}
                        >
                          {item.confidenceLevel}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Table Footer Approval Action Bar */}
        {datasetSuggestions.length > 0 && (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-t border-slate-200 bg-slate-50/70 px-5 py-3.5">
            <p className="text-xs text-slate-600">
              <span className="font-mono font-semibold tabular-nums text-[#0B192C]">
                {validSelectedIds.length}
              </span>{' '}
              of{' '}
              <span className="font-mono font-semibold tabular-nums text-[#0B192C]">
                {actionableSuggestions.length}
              </span>{' '}
              actionable repairs selected for approval
              {manualReviewSuggestions.length > 0 && (
                <span className="text-amber-700">
                  {' '}
                  · {manualReviewSuggestions.length} highlighted for manual review
                </span>
              )}
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={applying || validSelectedIds.length === 0}
                onClick={handleCancelRepairs}
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 whitespace-nowrap"
              >
                <X className="h-3.5 w-3.5 text-slate-500" />
                <span>Cancel Repairs</span>
              </button>
              <button
                type="button"
                disabled={applying || validSelectedIds.length === 0}
                onClick={handleApproveRepairs}
                className="inline-flex items-center gap-1.5 rounded-md bg-[#0B192C] px-4 py-1.5 text-xs font-medium text-white hover:bg-[#163155] disabled:opacity-40 whitespace-nowrap"
              >
                {applying ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-[#D9B352]" />
                ) : (
                  <Check className="h-3.5 w-3.5 text-[#D9B352]" />
                )}
                <span>
                  {applying
                    ? 'Applying...'
                    : `Approve Repairs (${validSelectedIds.length})`}
                </span>
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Modification History & Preserved Original vs Repaired Dataset Preview */}
      <section
        aria-label="Modification history and dataset preview"
        className="rounded-lg border border-slate-200 bg-white overflow-hidden"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-slate-200 px-5 py-3.5">
          <div className="flex items-center gap-1 rounded-md bg-slate-100 p-1 self-start">
            <button
              type="button"
              onClick={() => setBottomTab('history')}
              data-testid="tab-modification-history"
              className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-semibold transition-colors ${
                bottomTab === 'history'
                  ? 'bg-white text-[#0B192C] shadow-xs'
                  : 'text-slate-600 hover:text-[#0B192C]'
              }`}
            >
              <History className="h-3.5 w-3.5 text-[#0284C7]" />
              <span>Modification History ({datasetHistory.length})</span>
            </button>
            <button
              type="button"
              onClick={() => setBottomTab('preview')}
              data-testid="tab-dataset-preview"
              className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-semibold transition-colors ${
                bottomTab === 'preview'
                  ? 'bg-white text-[#0B192C] shadow-xs'
                  : 'text-slate-600 hover:text-[#0B192C]'
              }`}
            >
              <Table2 className="h-3.5 w-3.5 text-[#0284C7]" />
              <span>Dataset Comparison Preview</span>
            </button>
          </div>

          {bottomTab === 'preview' && activeDataset && (
            <div className="flex items-center gap-1 rounded-md bg-slate-100 p-1 self-start sm:self-auto">
              <button
                type="button"
                onClick={() => setPreviewVersion('current')}
                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                  previewVersion === 'current'
                    ? 'bg-white text-[#0B192C] shadow-xs'
                    : 'text-slate-600 hover:text-[#0B192C]'
                }`}
              >
                Current Repaired ({activeDataset.rows} rows)
              </button>
              <button
                type="button"
                onClick={() => setPreviewVersion('original')}
                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                  previewVersion === 'original'
                    ? 'bg-white text-[#0B192C] shadow-xs'
                    : 'text-slate-600 hover:text-[#0B192C]'
                }`}
              >
                Original Preserved ({activeDataset.originalPreviewRows?.length ?? activeDataset.rows} preview rows)
              </button>
            </div>
          )}
        </div>

        {bottomTab === 'history' ? (
          <div className="w-full overflow-x-auto">
            <table
              className="w-full min-w-[820px] border-collapse text-left text-xs"
              data-testid="modification-history-table"
            >
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  <th className="py-2.5 pl-5 pr-3">Timestamp</th>
                  <th className="px-3 py-2.5">Action</th>
                  <th className="px-3 py-2.5">Row & Column</th>
                  <th className="px-3 py-2.5">Original Value</th>
                  <th className="px-3 py-2.5">New Value</th>
                  <th className="px-3 py-2.5">Repair Method</th>
                  <th className="py-2.5 pl-3 pr-5">Confidence</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {datasetHistory.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-sm text-slate-500">
                      No modifications recorded yet for {activeDataset?.name ?? 'this dataset'}. Approve repairs above to log every cell and row change here.
                    </td>
                  </tr>
                ) : (
                  datasetHistory.map((entry) => (
                    <tr key={entry.id} className="hover:bg-[#EBF5FC]/35">
                      <td className="py-2.5 pl-5 pr-3 font-mono tabular-nums text-slate-500 whitespace-nowrap">
                        {entry.timestamp}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <span
                          className={`font-semibold ${
                            entry.action === 'Row Removed'
                              ? 'text-red-700'
                              : entry.action === 'Restored Original'
                                ? 'text-[#0284C7]'
                                : 'text-emerald-700'
                          }`}
                        >
                          {entry.action}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 font-mono whitespace-nowrap text-[#0B192C]">
                        {entry.rowNumber > 0 ? `Row ${entry.rowNumber} · ` : ''}
                        {entry.column}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-red-700 max-w-[160px] break-words whitespace-pre-wrap">
                        {formatCellDisplay(entry.originalValue)}
                      </td>
                      <td className="px-3 py-2.5 font-mono font-semibold text-emerald-700 max-w-[180px] break-words">
                        {entry.newValue}
                      </td>
                      <td className="px-3 py-2.5 text-slate-700 whitespace-nowrap">
                        {entry.repairMethod}
                      </td>
                      <td className="py-2.5 pl-3 pr-5 whitespace-nowrap">
                        <span
                          className={`font-semibold ${confidenceTextClass(
                            entry.confidenceLevel
                          )}`}
                        >
                          {entry.confidenceLevel}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        ) : activeDataset && previewRows.length > 0 ? (
          <div className="w-full overflow-x-auto">
            <table className="w-full min-w-[680px] border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                  <th className="py-2.5 pl-5 pr-3 font-mono font-medium">#</th>
                  {activeDataset.columnNames.map((col) => (
                    <th key={col} className="px-3 py-2.5 font-mono font-medium">
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {previewRows.slice(0, 10).map((row, idx) => (
                  <tr key={idx} className="h-9 hover:bg-[#EBF5FC]/35">
                    <td className="py-2 pl-5 pr-3 font-mono tabular-nums text-slate-400">
                      {idx + 1}
                    </td>
                    {activeDataset.columnNames.map((col) => {
                      const val = row[col];
                      const isEmpty = val === null || val === '';
                      return (
                        <td
                          key={col}
                          className={`px-3 py-2 font-mono tabular-nums ${
                            isEmpty ? 'text-amber-700 italic' : 'text-slate-700'
                          }`}
                        >
                          {isEmpty ? '(empty)' : String(val)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="py-8 text-center text-sm text-slate-500">
            No preview rows available for this dataset.
          </div>
        )}
      </section>
    </div>
  );
}
