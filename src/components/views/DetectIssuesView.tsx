import { AlertCircle, ArrowRight, ChevronLeft, ChevronRight, RefreshCw, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { datafixApi } from '../../services/api';
import type {
  DatasetRecord,
  DetectedIssueRecord,
  DetectionIssueType,
  IssueSeverity,
  NavSectionId,
  QualityIssue,
} from '../../types/datafix';

interface DetectIssuesViewProps {
  datasets: DatasetRecord[];
  selectedDatasetId: string;
  onSelectDataset: (id: string) => void;
  issues: QualityIssue[];
  detailedIssues: DetectedIssueRecord[];
  onScanComplete: () => Promise<void> | void;
  onNavigate: (section: NavSectionId) => void;
}

const SEVERITY_OPTIONS: ('All' | IssueSeverity)[] = [
  'All',
  'Critical',
  'Warning',
  'Info',
];

const ISSUE_TYPE_OPTIONS: ('All' | DetectionIssueType)[] = [
  'All',
  'Missing Values',
  'Duplicate Records',
  'Invalid Formats',
  'Inconsistent Values',
  'Anomalies',
];

const PAGE_SIZE = 50;

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

function issueTypeAccentClass(type: DetectionIssueType): string {
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

export function DetectIssuesView({
  datasets,
  selectedDatasetId,
  onSelectDataset,
  issues,
  detailedIssues,
  onScanComplete,
  onNavigate,
}: DetectIssuesViewProps) {
  const [issueTypeFilter, setIssueTypeFilter] = useState<'All' | DetectionIssueType>('All');
  const [severityFilter, setSeverityFilter] = useState<'All' | IssueSeverity>('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(1);
  const [scanning, setScanning] = useState(false);
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  const datasetNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const ds of datasets) {
      map.set(ds.id, ds.name);
    }
    return map;
  }, [datasets]);

  // Scope row-level issues to selected dataset (or all datasets)
  const datasetScopedIssues = useMemo(() => {
    if (!selectedDatasetId || selectedDatasetId === 'ALL') {
      return detailedIssues;
    }
    return detailedIssues.filter((item) => item.datasetId === selectedDatasetId);
  }, [detailedIssues, selectedDatasetId]);

  // Count per detection category from actual dataset issues
  const countsByType = useMemo(() => {
    const counts: Record<DetectionIssueType, number> = {
      'Missing Values': 0,
      'Duplicate Records': 0,
      'Invalid Formats': 0,
      'Inconsistent Values': 0,
      Anomalies: 0,
    };
    for (const item of datasetScopedIssues) {
      counts[item.issueType] += 1;
    }
    return counts;
  }, [datasetScopedIssues]);

  const filteredIssues = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return datasetScopedIssues.filter((item) => {
      if (issueTypeFilter !== 'All' && item.issueType !== issueTypeFilter) {
        return false;
      }
      if (severityFilter !== 'All' && item.severity !== severityFilter) {
        return false;
      }
      if (q.length > 0) {
        const rowStr = `row ${item.rowNumber}`;
        return (
          item.column.toLowerCase().includes(q) ||
          item.issueType.toLowerCase().includes(q) ||
          item.originalValue.toLowerCase().includes(q) ||
          item.description.toLowerCase().includes(q) ||
          item.suggestedAction.toLowerCase().includes(q) ||
          rowStr.includes(q) ||
          String(item.rowNumber) === q
        );
      }
      return true;
    });
  }, [datasetScopedIssues, issueTypeFilter, severityFilter, searchQuery]);

  // Reset pagination whenever filters or target dataset change
  useEffect(() => {
    setPage(1);
  }, [selectedDatasetId, issueTypeFilter, severityFilter, searchQuery]);

  const totalPages = Math.max(1, Math.ceil(filteredIssues.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * PAGE_SIZE;
  const paginatedIssues = filteredIssues.slice(pageStart, pageStart + PAGE_SIZE);

  const criticalCount = filteredIssues.filter((i) => i.severity === 'Critical').length;
  const affectedUniqueRows = useMemo(() => {
    const rowSet = new Set<string>();
    for (const item of filteredIssues) {
      rowSet.add(`${item.datasetId}:${item.rowNumber}`);
    }
    return rowSet.size;
  }, [filteredIssues]);

  const selectedDataset = datasets.find((ds) => ds.id === selectedDatasetId);
  const canScanSpecific = Boolean(selectedDataset);

  // Count distinct rule findings for dataset dropdown display
  const openRuleCountByDataset = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of detailedIssues) {
      map.set(item.datasetId, (map.get(item.datasetId) ?? 0) + 1);
    }
    for (const ds of datasets) {
      if (!map.has(ds.id)) {
        const fallback = issues.filter((i) => i.datasetId === ds.id).length;
        map.set(ds.id, fallback);
      }
    }
    return map;
  }, [detailedIssues, datasets, issues]);

  const handleRunScan = async () => {
    const targetId = canScanSpecific ? selectedDatasetId : datasets[0]?.id;
    if (!targetId) return;
    if (!canScanSpecific) {
      onSelectDataset(targetId);
    }
    setScanning(true);
    setScanMessage(null);
    setScanError(null);
    try {
      const result = await datafixApi.scanDataset(targetId);
      await onScanComplete();
      setScanMessage(
        `Scanned ${result.dataset.name}: detected ${result.issues.length} issue ${result.issues.length === 1 ? 'rule' : 'rules'} across ${result.dataset.rows.toLocaleString()} records (quality score ${result.dataset.qualityScore.toFixed(1)}%).`
      );
    } catch (err) {
      setScanError(
        err instanceof Error ? err.message : 'Unable to complete quality scan.'
      );
    } finally {
      setScanning(false);
    }
  };

  const handleProceedToDiagnosis = () => {
    if ((!selectedDatasetId || selectedDatasetId === 'ALL') && datasets[0]) {
      onSelectDataset(datasets[0].id);
    }
    onNavigate('diagnosis');
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[#0B192C]">
            Detect Issues
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Row-level quality detection across missing values, duplicate records, invalid formats, inconsistent categories, and IQR statistical anomalies.
          </p>
        </div>
        <div className="flex flex-wrap sm:flex-nowrap items-center gap-2.5 shrink-0">
          <button
            type="button"
            disabled={scanning || datasets.length === 0}
            onClick={handleRunScan}
            data-testid="run-quality-scan-btn"
            className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-[#0B192C] hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <RefreshCw
              className={`h-4 w-4 text-[#0284C7] ${scanning ? 'animate-spin' : ''}`}
            />
            <span>{scanning ? 'Scanning...' : 'Run Quality Scan'}</span>
          </button>
          <button
            type="button"
            onClick={handleProceedToDiagnosis}
            data-testid="proceed-to-diagnosis-btn"
            className="inline-flex items-center gap-2 rounded-md bg-[#0B192C] px-4 py-2 text-sm font-medium text-white hover:bg-[#163155] whitespace-nowrap shrink-0"
          >
            <span>Proceed to AI Diagnosis</span>
            <ArrowRight className="h-4 w-4 text-[#38BDF8]" />
          </button>
        </div>
      </div>

      {/* Dataset Selector & Detection Summary */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="lg:col-span-5 rounded-lg border border-slate-200 bg-white p-4">
          <label
            htmlFor="detect-dataset-select"
            className="block text-xs font-medium text-slate-500"
          >
            Target Dataset
          </label>
          <select
            id="detect-dataset-select"
            value={selectedDatasetId}
            onChange={(e) => onSelectDataset(e.target.value)}
            className="mt-1.5 w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium text-[#0B192C] focus:border-[#0284C7] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0284C7]/20"
          >
            <option value="ALL">
              All Monitored Datasets ({detailedIssues.length} detected issues)
            </option>
            {datasets.map((ds) => (
              <option key={ds.id} value={ds.id}>
                {ds.name} ({openRuleCountByDataset.get(ds.id) ?? 0} issues)
              </option>
            ))}
          </select>
        </div>

        <div className="lg:col-span-3 rounded-lg border border-slate-200 bg-white p-4">
          <p className="text-xs font-medium text-slate-500">Detected Issues</p>
          <p
            className="mt-1.5 font-mono text-2xl font-semibold tabular-nums text-[#0B192C]"
            data-testid="detected-issues-total"
          >
            {filteredIssues.length.toLocaleString()}
            <span className="ml-2 font-sans text-xs font-semibold text-red-700">
              {criticalCount} critical
            </span>
          </p>
        </div>

        <div className="lg:col-span-2 rounded-lg border border-slate-200 bg-white p-4">
          <p className="text-xs font-medium text-slate-500">Affected Rows</p>
          <p className="mt-1.5 font-mono text-2xl font-semibold tabular-nums text-[#0B192C]">
            {affectedUniqueRows.toLocaleString()}
          </p>
        </div>

        <div className="lg:col-span-2 rounded-lg border border-[#D9B352]/60 bg-white p-4">
          <p className="text-xs font-medium text-slate-500">
            {selectedDataset ? 'Quality Score' : 'Datasets Scanned'}
          </p>
          <p className="mt-1.5 font-mono text-2xl font-semibold tabular-nums text-[#0B192C]">
            {selectedDataset
              ? `${selectedDataset.qualityScore.toFixed(1)}%`
              : `${datasets.length} files`}
          </p>
        </div>
      </div>

      {/* 5 Detection Category Cards (Interactive Filter) */}
      <section
        aria-label="Issue category breakdown"
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5"
      >
        {(
          [
            'Missing Values',
            'Duplicate Records',
            'Invalid Formats',
            'Inconsistent Values',
            'Anomalies',
          ] as DetectionIssueType[]
        ).map((category) => {
          const active = issueTypeFilter === category;
          const count = countsByType[category];
          return (
            <button
              key={category}
              type="button"
              onClick={() =>
                setIssueTypeFilter((prev) => (prev === category ? 'All' : category))
              }
              className={`rounded-lg border p-3.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0284C7] ${
                active
                  ? 'border-[#0284C7] bg-[#EBF5FC]/55'
                  : 'border-slate-200 bg-white hover:border-slate-300'
              }`}
            >
              <p className="text-xs font-medium text-slate-500 truncate">{category}</p>
              <p
                className={`mt-1 font-mono text-xl font-semibold tabular-nums ${issueTypeAccentClass(
                  category
                )}`}
              >
                {count.toLocaleString()}
              </p>
            </button>
          );
        })}
      </section>

      {scanMessage && (
        <div
          role="status"
          className="rounded-lg border border-[#0284C7]/30 bg-[#EBF5FC] px-4 py-3 text-sm text-[#0B192C]"
        >
          {scanMessage}
        </div>
      )}

      {scanError && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"
        >
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-red-600 shrink-0" aria-hidden="true" />
            <span>{scanError}</span>
          </div>
          <button
            type="button"
            disabled={scanning}
            onClick={handleRunScan}
            className="rounded border border-red-300 bg-white px-3 py-1 text-xs font-semibold text-red-800 hover:bg-red-50"
          >
            Retry Scan
          </button>
        </div>
      )}

      {/* Row-Level Detected Issues Table */}
      <section
        aria-label="Detected quality issues table"
        className="rounded-lg border border-slate-200 bg-white overflow-hidden"
      >
        <div className="flex flex-col gap-3 border-b border-slate-200 px-5 py-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-[#0B192C]">
              Detected Quality Issues
            </h2>
            <p className="text-xs text-slate-500 truncate">
              Exact 1-based data row numbers matching your uploaded dataset
              {selectedDataset ? ` · ${selectedDataset.name}` : ''}
            </p>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap xl:flex-nowrap sm:items-center shrink-0">
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
              />
              <label htmlFor="detect-issue-search" className="sr-only">
                Search detected issues
              </label>
              <input
                id="detect-issue-search"
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search column, row, or value..."
                className="w-full sm:w-48 rounded-md border border-slate-200 bg-slate-50 py-1.5 pl-8 pr-3 text-xs text-[#0B192C] placeholder:text-slate-400 focus:border-[#0284C7] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0284C7]/20"
              />
            </div>

            <label htmlFor="detect-type-filter" className="sr-only">
              Filter by issue type
            </label>
            <select
              id="detect-type-filter"
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
              aria-label="Filter issues by severity"
              className="flex items-center gap-1 rounded-md bg-slate-100 p-1 self-start sm:self-auto"
            >
              {SEVERITY_OPTIONS.map((sev) => (
                <button
                  key={sev}
                  type="button"
                  onClick={() => setSeverityFilter(sev)}
                  className={`rounded px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors ${
                    severityFilter === sev
                      ? 'bg-white text-[#0B192C] shadow-xs'
                      : 'text-slate-600 hover:text-[#0B192C]'
                  }`}
                >
                  {sev}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="w-full overflow-x-auto">
          <table
            className="w-full min-w-[980px] border-collapse text-left text-xs"
            data-testid="detected-issues-table"
          >
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                <th className="py-3 pl-5 pr-3 whitespace-nowrap">Issue Type</th>
                <th className="px-3 py-3 whitespace-nowrap">Column Name</th>
                <th className="px-3 py-3 text-right whitespace-nowrap">Row Number</th>
                <th className="px-3 py-3 whitespace-nowrap">Original Value</th>
                <th className="px-3 py-3">Description</th>
                <th className="px-3 py-3 whitespace-nowrap">Severity</th>
                <th className="py-3 pl-3 pr-5">Suggested Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {paginatedIssues.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="py-10 text-center text-sm text-slate-500"
                  >
                    No data quality issues match the current dataset, category, and severity filters.
                  </td>
                </tr>
              ) : (
                paginatedIssues.map((issue) => {
                  const isEmptyVal = issue.originalValue === '(empty)';
                  const dsName =
                    issue.datasetName ?? datasetNameMap.get(issue.datasetId);
                  return (
                    <tr
                      key={issue.id}
                      className="align-top transition-colors hover:bg-[#EBF5FC]/40"
                    >
                      <td className="py-3 pl-5 pr-3 whitespace-nowrap">
                        <span
                          className={`font-semibold ${issueTypeAccentClass(
                            issue.issueType
                          )}`}
                        >
                          {issue.issueType}
                        </span>
                      </td>
                      <td className="px-3 py-3 whitespace-nowrap">
                        <div className="font-mono font-semibold text-[#0B192C]">
                          {issue.column}
                        </div>
                        {selectedDatasetId === 'ALL' && dsName && (
                          <div className="mt-0.5 font-mono text-[11px] text-slate-400">
                            {dsName}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right font-mono tabular-nums font-semibold text-[#0B192C] whitespace-nowrap">
                        Row {issue.rowNumber}
                      </td>
                      <td className="px-3 py-3 font-mono tabular-nums max-w-[180px] break-words">
                        <span
                          className={
                            isEmptyVal
                              ? 'italic text-amber-700'
                              : 'text-slate-700'
                          }
                        >
                          {issue.originalValue}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-slate-700 leading-relaxed max-w-[280px]">
                        {issue.description}
                      </td>
                      <td className="px-3 py-3 whitespace-nowrap">
                        <span
                          className={`font-semibold ${severityTextClass(
                            issue.severity
                          )}`}
                        >
                          {issue.severity}
                        </span>
                      </td>
                      <td className="py-3 pl-3 pr-5 text-slate-600 leading-relaxed max-w-[260px]">
                        {issue.suggestedAction}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Footer */}
        {filteredIssues.length > PAGE_SIZE && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50/50 px-5 py-3 text-xs text-slate-600">
            <span className="font-mono tabular-nums">
              Showing {pageStart + 1}–
              {Math.min(pageStart + PAGE_SIZE, filteredIssues.length)} of{' '}
              {filteredIssues.length.toLocaleString()} detected issues
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={safePage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2.5 py-1 font-medium text-[#0B192C] hover:bg-slate-50 disabled:opacity-40"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                <span>Previous</span>
              </button>
              <span className="font-mono tabular-nums">
                Page {safePage} / {totalPages}
              </span>
              <button
                type="button"
                disabled={safePage >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2.5 py-1 font-medium text-[#0B192C] hover:bg-slate-50 disabled:opacity-40"
              >
                <span>Next</span>
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
