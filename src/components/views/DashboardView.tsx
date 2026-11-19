import { ArrowRight, Search, Upload } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type {
  AuditEntry,
  DashboardSummary,
  DatasetRecord,
  DatasetStatus,
  DiagnosisInsight,
  NavSectionId,
  QualityIssue,
} from '../../types/datafix';
import {
  computeDashboardMetrics,
  filterDatasets,
  formatQualityDelta,
} from '../../utils/qualityMetrics';

interface DashboardViewProps {
  summary: DashboardSummary | null;
  datasets: DatasetRecord[];
  issues: QualityIssue[];
  audits: AuditEntry[];
  diagnoses: DiagnosisInsight[];
  loading: boolean;
  onInspectDataset: (datasetId: string, destination: NavSectionId) => void;
  onNavigate: (section: NavSectionId) => void;
}

const STATUS_FILTERS: ('All' | DatasetStatus)[] = [
  'All',
  'Needs Review',
  'In Repair',
  'Validated',
  'Ingested',
];

const DISTRIBUTION_COLORS = ['#0B192C', '#C4962C', '#0284C7'];
const CATEGORY_BAR_COLORS = ['#0B192C', '#0284C7', '#C4962C', '#38BDF8', '#475569'];

function statusTextClass(status: DatasetStatus): string {
  switch (status) {
    case 'Validated':
      return 'text-emerald-700';
    case 'In Repair':
      return 'text-[#0284C7]';
    case 'Needs Review':
      return 'text-amber-700';
    case 'Ingested':
      return 'text-slate-600';
  }
}

export function DashboardView({
  summary,
  datasets,
  issues,
  audits,
  diagnoses,
  loading,
  onInspectDataset,
  onNavigate,
}: DashboardViewProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'All' | DatasetStatus>('All');

  const metrics = useMemo(
    () => computeDashboardMetrics(datasets, issues, audits, diagnoses),
    [datasets, issues, audits, diagnoses]
  );

  const filteredDatasets = useMemo(
    () => filterDatasets(metrics.activeDatasets, searchQuery, statusFilter),
    [metrics.activeDatasets, searchQuery, statusFilter]
  );

  const totalDistributionIssues = metrics.issueDistribution.reduce(
    (sum, item) => sum + item.value,
    0
  );

  const analysisItems = useMemo(() => {
    const datasetNameById = new Map(datasets.map((d) => [d.id, d.name]));
    if (metrics.activeDiagnoses.length > 0) {
      return metrics.activeDiagnoses.slice(0, 4).map((diag) => ({
        id: diag.id,
        datasetId: diag.datasetId,
        datasetName: datasetNameById.get(diag.datasetId) ?? 'Dataset',
        column: diag.column,
        headline: diag.rootCause,
        actionText: diag.recommendedAction,
        metaLabel: `${diag.confidenceLabel} Confidence · ${diag.source}`,
        destination: 'diagnosis' as NavSectionId,
      }));
    }

    return metrics.activeIssues.slice(0, 4).map((issue) => ({
      id: issue.id,
      datasetId: issue.datasetId,
      datasetName: datasetNameById.get(issue.datasetId) ?? 'Dataset',
      column: issue.column,
      headline: `${issue.category}: ${issue.ruleTriggered} (${issue.affectedRows} affected rows)`,
      actionText: `Sample flagged value: ${issue.sampleValue}`,
      metaLabel: `${issue.severity} · Rule Scan`,
      destination: 'detect' as NavSectionId,
    }));
  }, [datasets, metrics.activeDiagnoses, metrics.activeIssues]);

  if (loading && !summary && datasets.length === 0) {
    return (
      <div className="space-y-6" aria-busy="true">
        <div className="h-28 rounded-lg border border-slate-200 bg-white p-6 animate-pulse" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {[1, 2, 3, 4, 5].map((slot) => (
            <div
              key={slot}
              className="h-28 rounded-lg border border-slate-200 bg-white p-5 animate-pulse"
            />
          ))}
        </div>
        <div className="h-72 rounded-lg border border-slate-200 bg-white animate-pulse" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Welcome Banner + Quick Upload Dataset CTA */}
      <section
        aria-label="Dashboard welcome"
        className="rounded-lg border border-slate-200 bg-white p-5 sm:p-6"
      >
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-[#0B192C]">
              Welcome to Data Fix – Make Your Data Accurate, Reliable and Trustworthy.
            </h1>
            <p className="mt-2 text-xs sm:text-sm text-slate-600">
              {metrics.isDemoMode ? (
                <>
                  <span className="font-semibold text-[#A17816]">
                    Demonstration Data
                  </span>
                  <span aria-hidden="true" className="mx-2 text-slate-300">
                    ·
                  </span>
                  <span>
                    Displaying sample quality metrics until a real CSV or Excel dataset is uploaded.
                  </span>
                </>
              ) : (
                <>
                  <span className="font-semibold text-emerald-700">
                    Live Dataset Metrics
                  </span>
                  <span aria-hidden="true" className="mx-2 text-slate-300">
                    ·
                  </span>
                  <span>
                    Showing real-time analysis across {metrics.activeDatasets.length}{' '}
                    uploaded {metrics.activeDatasets.length === 1 ? 'dataset' : 'datasets'}.
                  </span>
                </>
              )}
            </p>
          </div>

          <button
            type="button"
            onClick={() => onNavigate('upload')}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-[#0B192C] px-4 py-2.5 text-sm font-medium text-white transition-colors duration-150 hover:bg-[#163155] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0284C7] focus-visible:ring-offset-2 whitespace-nowrap shrink-0 self-start lg:self-auto"
          >
            <Upload className="h-4 w-4 text-[#38BDF8]" />
            <span>Quick Upload Dataset</span>
          </button>
        </div>
      </section>

      {/* Top 5 Summary Cards */}
      <section
        aria-label="Top summary metrics"
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5"
      >
        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <p className="text-xs font-medium text-slate-500">Total Records</p>
          <p className="mt-2 font-mono text-2xl sm:text-3xl font-semibold tabular-nums text-[#0B192C]">
            {metrics.totalRecords.toLocaleString()}
          </p>
          <p className="mt-2 text-xs text-slate-500">
            Across {metrics.activeDatasets.length}{' '}
            {metrics.isDemoMode ? 'demo' : 'uploaded'}{' '}
            {metrics.activeDatasets.length === 1 ? 'dataset' : 'datasets'}
          </p>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <p className="text-xs font-medium text-slate-500">Missing Values</p>
          <p className="mt-2 font-mono text-2xl sm:text-3xl font-semibold tabular-nums text-[#0B192C]">
            {metrics.missingValues.toLocaleString()}
          </p>
          <p className="mt-2 text-xs text-slate-500">
            Null or blank cells flagged
          </p>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <p className="text-xs font-medium text-slate-500">Duplicate Records</p>
          <p className="mt-2 font-mono text-2xl sm:text-3xl font-semibold tabular-nums text-[#0B192C]">
            {metrics.duplicateRecords.toLocaleString()}
          </p>
          <p className="mt-2 text-xs text-slate-500">
            Conflicting primary key rows
          </p>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <p className="text-xs font-medium text-slate-500">Invalid Entries</p>
          <p className="mt-2 font-mono text-2xl sm:text-3xl font-semibold tabular-nums text-[#0284C7]">
            {metrics.invalidEntries.toLocaleString()}
          </p>
          <p className="mt-2 text-xs text-slate-500">
            Schema, format, or range errors
          </p>
        </div>

        <div className="rounded-lg border border-[#D9B352]/60 bg-white p-5 sm:col-span-2 lg:col-span-1">
          <p className="text-xs font-medium text-slate-500">Data Quality Score</p>
          <p className="mt-2 font-mono text-2xl sm:text-3xl font-semibold tabular-nums text-[#0B192C]">
            {metrics.dataQualityScore.toFixed(1)}%
          </p>
          <p className="mt-2 text-xs text-[#A17816]">
            Target 95% · {metrics.isDemoMode ? 'Demo baseline' : 'Live index'}
          </p>
        </div>
      </section>

      {/* Charts Row 1: Data Quality Overview + Issue Distribution */}
      <section
        aria-label="Primary quality charts"
        className="grid grid-cols-1 gap-5 xl:grid-cols-12"
      >
        <div className="xl:col-span-7 min-w-0 rounded-lg border border-slate-200 bg-white p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2 pb-4 border-b border-slate-100">
            <div>
              <h2 className="text-base font-semibold text-[#0B192C]">
                Data Quality Overview
              </h2>
              <p className="text-xs text-slate-500">
                Current quality score (%) compared with initial baseline across datasets
                {metrics.isDemoMode ? ' · Demonstration Data' : ''}
              </p>
            </div>
            <div className="flex items-center gap-4 text-xs text-slate-600">
              <span className="flex items-center gap-1.5">
                <span
                  className="inline-block h-2 w-2 rounded-xs bg-[#0284C7]"
                  aria-hidden="true"
                />
                Current Score
              </span>
              <span className="flex items-center gap-1.5">
                <span
                  className="inline-block h-2 w-2 rounded-xs bg-[#0B192C]"
                  aria-hidden="true"
                />
                Baseline
              </span>
            </div>
          </div>

          <div
            className="mt-4 h-64 w-full min-w-0"
            data-testid="data-quality-overview-chart"
          >
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <ComposedChart
                data={metrics.qualityOverviewSeries}
                margin={{ top: 8, right: 12, left: -12, bottom: 0 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="#E2E8F0"
                  vertical={false}
                />
                <XAxis
                  dataKey="label"
                  tick={{ fill: '#334155', fontSize: 11.5 }}
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
                  dataKey="qualityScore"
                  name="Current Score (%)"
                  fill="#0284C7"
                  radius={[4, 4, 0, 0]}
                  barSize={32}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="baselineScore"
                  name="Baseline Score (%)"
                  stroke="#0B192C"
                  strokeWidth={2.2}
                  dot={{ r: 3.5, fill: '#C4962C', stroke: '#0B192C', strokeWidth: 1.5 }}
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="xl:col-span-5 min-w-0 rounded-lg border border-slate-200 bg-white p-5">
          <div className="pb-4 border-b border-slate-100">
            <h2 className="text-base font-semibold text-[#0B192C]">
              Issue Distribution
            </h2>
            <p className="text-xs text-slate-500">
              Share of missing values, duplicate records, and invalid entries
              {metrics.isDemoMode ? ' · Demonstration Data' : ''}
            </p>
          </div>

          {totalDistributionIssues === 0 ? (
            <div className="flex h-64 flex-col items-center justify-center text-center px-4">
              <p className="font-mono text-2xl font-semibold text-emerald-700 tabular-nums">
                0 Issues
              </p>
              <p className="mt-1 text-xs text-slate-500">
                All active records passed completeness, uniqueness, and format checks.
              </p>
            </div>
          ) : (
            <div className="mt-4 grid grid-cols-1 sm:grid-cols-12 items-center gap-4">
              <div
                className="sm:col-span-5 h-52 w-full min-w-0"
                data-testid="issue-distribution-chart"
              >
                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                  <PieChart>
                    <Pie
                      data={metrics.issueDistribution}
                      dataKey="value"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      innerRadius={44}
                      outerRadius={68}
                      paddingAngle={2}
                      stroke="none"
                      isAnimationActive={false}
                    >
                      {metrics.issueDistribution.map((entry, idx) => (
                        <Cell
                          key={entry.name}
                          fill={DISTRIBUTION_COLORS[idx % DISTRIBUTION_COLORS.length]}
                        />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#0B192C',
                        border: '1px solid #1D3A61',
                        borderRadius: '6px',
                        color: '#F8FAFC',
                        fontSize: '12px',
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>

              <div className="sm:col-span-7 space-y-3 min-w-0">
                <div className="pb-2 border-b border-slate-100">
                  <p className="text-xs text-slate-500">Total Flagged</p>
                  <p className="font-mono text-xl font-semibold tabular-nums text-[#0B192C]">
                    {totalDistributionIssues.toLocaleString()}
                  </p>
                </div>
                {metrics.issueDistribution.map((item, idx) => (
                  <div
                    key={item.name}
                    className="flex items-center justify-between gap-3 text-xs"
                  >
                    <span className="flex items-center gap-2 text-slate-700 whitespace-nowrap">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-xs"
                        style={{
                          backgroundColor:
                            DISTRIBUTION_COLORS[idx % DISTRIBUTION_COLORS.length],
                        }}
                        aria-hidden="true"
                      />
                      <span>{item.name}</span>
                    </span>
                    <span className="font-mono tabular-nums font-medium text-[#0B192C] whitespace-nowrap">
                      {item.value} ({item.percent}%)
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Row 2: Detected Errors by Category + Latest Analysis Results */}
      <section
        aria-label="Category breakdown and analysis results"
        className="grid grid-cols-1 gap-5 xl:grid-cols-12"
      >
        <div className="xl:col-span-6 min-w-0 rounded-lg border border-slate-200 bg-white p-5">
          <div className="pb-4 border-b border-slate-100">
            <h2 className="text-base font-semibold text-[#0B192C]">
              Detected Errors by Category
            </h2>
            <p className="text-xs text-slate-500">
              Flagged rows grouped across all five quality rule categories
              {metrics.isDemoMode ? ' · Demonstration Data' : ''}
            </p>
          </div>

          <div
            className="mt-4 h-64 w-full min-w-0"
            data-testid="detected-errors-category-chart"
          >
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <BarChart
                data={metrics.errorsByCategory}
                layout="vertical"
                margin={{ top: 4, right: 20, left: 8, bottom: 0 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="#E2E8F0"
                  horizontal={false}
                />
                <XAxis
                  type="number"
                  allowDecimals={false}
                  tick={{ fill: '#64748B', fontSize: 12 }}
                  axisLine={{ stroke: '#E2E8F0' }}
                  tickLine={false}
                />
                <YAxis
                  type="category"
                  dataKey="category"
                  width={142}
                  tick={{ fill: '#334155', fontSize: 11.5 }}
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
                <Bar
                  dataKey="count"
                  name="Detected Errors"
                  radius={[0, 4, 4, 0]}
                  barSize={20}
                  isAnimationActive={false}
                >
                  {metrics.errorsByCategory.map((entry, idx) => (
                    <Cell
                      key={entry.category}
                      fill={CATEGORY_BAR_COLORS[idx % CATEGORY_BAR_COLORS.length]}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="xl:col-span-6 min-w-0 rounded-lg border border-slate-200 bg-white flex flex-col overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-5 py-4">
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-[#0B192C]">
                Latest Analysis Results
              </h2>
              <p className="text-xs text-slate-500">
                Most recent rule diagnostics and AI root-cause findings
                {metrics.isDemoMode ? ' · Demonstration Data' : ''}
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('diagnosis')}
              className="inline-flex items-center gap-1 text-xs font-semibold text-[#0284C7] hover:text-[#0B192C] whitespace-nowrap"
            >
              <span>Open AI Diagnosis</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="divide-y divide-slate-100 flex-1">
            {analysisItems.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">
                No anomalies flagged in the latest scan. Your uploaded dataset passed all automated checks.
              </div>
            ) : (
              analysisItems.map((item) => (
                <div key={item.id} className="px-5 py-3.5 hover:bg-[#EBF5FC]/35">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center text-xs min-w-0">
                      <span className="font-mono font-semibold text-[#0B192C]">
                        {item.column}
                      </span>
                      <span aria-hidden="true" className="mx-1.5 text-slate-300">
                        ·
                      </span>
                      <span className="font-mono text-slate-500 break-all">
                        {item.datasetName}
                      </span>
                    </div>
                    <span className="text-xs font-medium text-[#A17816]">
                      {item.metaLabel}
                    </span>
                  </div>
                  <p className="mt-1.5 text-sm text-slate-700 line-clamp-2">
                    {item.headline}
                  </p>
                  <div className="mt-2 flex items-center justify-between gap-2 min-w-0">
                    <p className="text-xs text-slate-500 truncate min-w-0 flex-1">
                      {item.actionText}
                    </p>
                    <button
                      type="button"
                      onClick={() =>
                        onInspectDataset(item.datasetId, item.destination)
                      }
                      className="text-xs font-semibold text-[#0284C7] hover:text-[#0B192C] whitespace-nowrap shrink-0"
                    >
                      Review
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      {/* Recent Dataset Activity Section */}
      <section
        aria-label="Recent dataset activity"
        className="rounded-lg border border-slate-200 bg-white overflow-hidden"
      >
        <div className="flex flex-col gap-3 border-b border-slate-200 p-5 lg:flex-row lg:items-center lg:justify-between min-w-0">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-[#0B192C]">
              Recent Dataset Activity
            </h2>
            <p className="text-xs text-slate-500">
              Active datasets, quality scores, and recent pipeline events
              {metrics.isDemoMode ? ' · Demonstration Data' : ''}
            </p>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center min-w-0 max-w-full">
            <div className="relative min-w-0">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
              />
              <label htmlFor="dataset-search" className="sr-only">
                Search datasets
              </label>
              <input
                id="dataset-search"
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filter datasets..."
                className="w-full sm:w-52 rounded-md border border-slate-200 bg-slate-50 py-1.5 pl-9 pr-3 text-sm text-[#0B192C] placeholder:text-slate-400 focus:border-[#0284C7] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0284C7]/20"
              />
            </div>

            <div
              role="group"
              aria-label="Filter datasets by status"
              className="flex flex-wrap sm:flex-nowrap items-center gap-1 overflow-x-auto max-w-full rounded-md bg-slate-100 p-1"
            >
              {STATUS_FILTERS.map((status) => {
                const active = statusFilter === status;
                return (
                  <button
                    key={status}
                    type="button"
                    onClick={() => setStatusFilter(status)}
                    className={`rounded px-2.5 py-1 text-xs font-medium whitespace-nowrap shrink-0 transition-colors ${
                      active
                        ? 'bg-white text-[#0B192C] shadow-xs'
                        : 'text-slate-600 hover:text-[#0B192C]'
                    }`}
                  >
                    {status}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="min-w-0">
          {/* Full-width Dataset Directory Table */}
          <div className="w-full min-w-0 overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                  <th className="py-3 pl-5 pr-3">Dataset</th>
                  <th className="px-3 py-3 text-right">Records</th>
                  <th className="px-3 py-3 text-right">Quality Score</th>
                  <th className="px-3 py-3 text-right">Open Issues</th>
                  <th className="px-3 py-3">Status</th>
                  <th className="py-3 pl-3 pr-5 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredDatasets.length === 0 ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="py-10 text-center text-sm text-slate-500"
                    >
                      No datasets match the current filter. Clear your filter or upload a new file.
                    </td>
                  </tr>
                ) : (
                  filteredDatasets.map((ds) => (
                    <tr
                      key={ds.id}
                      className="h-11 transition-colors hover:bg-[#EBF5FC]/45"
                    >
                      <td className="py-3 pl-5 pr-3">
                        <div className="font-medium text-[#0B192C]">{ds.name}</div>
                        <div className="text-xs text-slate-500">
                          <span>{ds.fileType}</span>
                          <span aria-hidden="true" className="mx-1.5">
                            ·
                          </span>
                          <span className="font-mono tabular-nums">
                            {ds.uploadedAt}
                          </span>
                          {ds.isDemo && (
                            <>
                              <span aria-hidden="true" className="mx-1.5">
                                ·
                              </span>
                              <span className="text-[#A17816]">Demo</span>
                            </>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right font-mono tabular-nums text-slate-700 whitespace-nowrap">
                        {ds.rows.toLocaleString()}
                      </td>
                      <td className="px-3 py-3 text-right font-mono tabular-nums whitespace-nowrap">
                        <span className="font-semibold text-[#0B192C]">
                          {ds.qualityScore.toFixed(1)}%
                        </span>
                        <span className="ml-1.5 text-xs text-[#A17816]">
                          {formatQualityDelta(ds.qualityScore, ds.previousScore)}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right font-mono tabular-nums text-slate-700 whitespace-nowrap">
                        {ds.openIssues}
                      </td>
                      <td className="px-3 py-3 whitespace-nowrap">
                        <span
                          className={`text-xs font-semibold ${statusTextClass(
                            ds.status
                          )}`}
                        >
                          {ds.status}
                        </span>
                      </td>
                      <td className="py-3 pl-3 pr-5 text-right whitespace-nowrap">
                        <button
                          type="button"
                          aria-label={`Inspect ${ds.name}`}
                          onClick={() => onInspectDataset(ds.id, 'detect')}
                          className="inline-flex items-center gap-1 text-xs font-semibold text-[#0284C7] hover:text-[#0B192C] whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0284C7] rounded px-1.5 py-1"
                        >
                          <span>Inspect</span>
                          <ArrowRight className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Recent Pipeline Events Strip */}
          <div className="border-t border-slate-200 bg-slate-50/40 p-5">
            <div className="flex items-center justify-between gap-2 pb-3">
              <h3 className="text-sm font-semibold text-[#0B192C]">
                Latest Pipeline Events
              </h3>
              <button
                type="button"
                onClick={() => onNavigate('audit')}
                className="inline-flex items-center gap-1 text-xs font-semibold text-[#0284C7] hover:text-[#0B192C] whitespace-nowrap"
              >
                <span>Full History</span>
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>

            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {metrics.activeAudits.slice(0, 4).map((entry) => (
                <li
                  key={entry.id}
                  className="rounded-md border border-slate-200 bg-white p-3.5 min-w-0"
                >
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-semibold text-[#0B192C] whitespace-nowrap">
                      {entry.stage}
                    </span>
                    <span className="font-mono tabular-nums text-slate-400 whitespace-nowrap">
                      {entry.timestamp}
                    </span>
                  </div>
                  <p className="mt-1 font-mono text-xs text-[#0284C7] truncate">
                    {entry.datasetName}
                  </p>
                  <p className="mt-1 text-xs text-slate-600 leading-relaxed line-clamp-2">
                    {entry.action}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>
    </div>
  );
}
