import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import type {
  AuditEntry,
  DataRow,
  DatasetRecord,
  DatasetStatus,
  DiagnosisInsight,
  IssueCategory,
  IssueSeverity,
  QualityIssue,
} from '../types/datafix';

export interface DashboardComputedMetrics {
  isDemoMode: boolean;
  activeDatasets: DatasetRecord[];
  activeIssues: QualityIssue[];
  activeAudits: AuditEntry[];
  activeDiagnoses: DiagnosisInsight[];
  totalRecords: number;
  missingValues: number;
  duplicateRecords: number;
  invalidEntries: number;
  dataQualityScore: number;
  qualityOverviewSeries: {
    label: string;
    qualityScore: number;
    baselineScore: number;
    records: number;
  }[];
  issueDistribution: {
    name: string;
    value: number;
    percent: number;
  }[];
  errorsByCategory: {
    category: IssueCategory;
    count: number;
  }[];
}

export function computeDashboardMetrics(
  datasets: DatasetRecord[],
  issues: QualityIssue[],
  audits: AuditEntry[],
  diagnoses: DiagnosisInsight[]
): DashboardComputedMetrics {
  const realDatasets = datasets.filter((ds) => ds.isDemo === false);
  const isDemoMode = realDatasets.length === 0;
  const activeDatasets = isDemoMode ? datasets : realDatasets;
  const activeIds = new Set(activeDatasets.map((ds) => ds.id));
  const activeNames = new Set(activeDatasets.map((ds) => ds.name));

  const activeIssues = issues.filter((issue) => activeIds.has(issue.datasetId));
  const activeDiagnoses = diagnoses.filter((d) => activeIds.has(d.datasetId));
  const activeAudits = isDemoMode
    ? audits
    : audits.filter((entry) => activeNames.has(entry.datasetName));

  const totalRecords = activeDatasets.reduce((sum, ds) => sum + ds.rows, 0);

  let missingValues = 0;
  let duplicateRecords = 0;
  let invalidEntries = 0;

  const categoryTotals = new Map<IssueCategory, number>([
    ['Missing Values', 0],
    ['Schema Mismatch', 0],
    ['Duplicate Keys', 0],
    ['Format Drift', 0],
    ['Outlier Range', 0],
  ]);

  for (const issue of activeIssues) {
    categoryTotals.set(
      issue.category,
      (categoryTotals.get(issue.category) ?? 0) + issue.affectedRows
    );
    if (issue.category === 'Missing Values') {
      missingValues += issue.affectedRows;
    } else if (issue.category === 'Duplicate Keys') {
      duplicateRecords += issue.affectedRows;
    } else {
      invalidEntries += issue.affectedRows;
    }
  }

  const dataQualityScore =
    activeDatasets.length > 0
      ? Math.round(
          (activeDatasets.reduce((sum, ds) => sum + ds.qualityScore, 0) /
            activeDatasets.length) *
            10
        ) / 10
      : 0;

  const totalIssueRows = missingValues + duplicateRecords + invalidEntries;
  const rawDistribution = [
    { name: 'Missing Values', value: missingValues },
    { name: 'Duplicate Records', value: duplicateRecords },
    { name: 'Invalid Entries', value: invalidEntries },
  ];

  const issueDistribution = rawDistribution.map((slice) => ({
    ...slice,
    percent:
      totalIssueRows > 0
        ? Math.round((slice.value / totalIssueRows) * 1000) / 10
        : 0,
  }));

  const errorsByCategory: { category: IssueCategory; count: number }[] = [
    'Missing Values',
    'Schema Mismatch',
    'Duplicate Keys',
    'Format Drift',
    'Outlier Range',
  ].map((category) => ({
    category: category as IssueCategory,
    count: categoryTotals.get(category as IssueCategory) ?? 0,
  }));

  const qualityOverviewSeries = activeDatasets.map((ds) => ({
    label: ds.name.replace(/\.(csv|xlsx|xls)$/i, ''),
    qualityScore: ds.qualityScore,
    baselineScore: ds.previousScore,
    records: ds.rows,
  }));

  return {
    isDemoMode,
    activeDatasets,
    activeIssues,
    activeAudits,
    activeDiagnoses,
    totalRecords,
    missingValues,
    duplicateRecords,
    invalidEntries,
    dataQualityScore,
    qualityOverviewSeries,
    issueDistribution,
    errorsByCategory,
  };
}

export function filterDatasets(
  datasets: DatasetRecord[],
  query: string,
  statusFilter: 'All' | DatasetStatus
): DatasetRecord[] {
  const normalizedQuery = query.trim().toLowerCase();
  return datasets.filter((dataset) => {
    const matchesStatus =
      statusFilter === 'All' || dataset.status === statusFilter;
    const matchesQuery =
      normalizedQuery.length === 0 ||
      dataset.name.toLowerCase().includes(normalizedQuery) ||
      dataset.fileType.toLowerCase().includes(normalizedQuery);
    return matchesStatus && matchesQuery;
  });
}

export function filterIssues(
  issues: QualityIssue[],
  datasetId: string | 'ALL',
  severity: 'All' | IssueSeverity
): QualityIssue[] {
  return issues.filter((issue) => {
    const matchesDataset =
      datasetId === 'ALL' || issue.datasetId === datasetId;
    const matchesSeverity =
      severity === 'All' || issue.severity === severity;
    return matchesDataset && matchesSeverity;
  });
}

export function formatQualityDelta(current: number, previous: number): string {
  const delta = Math.round((current - previous) * 10) / 10;
  if (delta > 0) return `+${delta.toFixed(1)}%`;
  if (delta < 0) return `${delta.toFixed(1)}%`;
  return '0.0%';
}

export function serializeRowsToCsv(rows: DataRow[]): string {
  if (rows.length === 0) return '';
  return Papa.unparse(rows);
}

export interface ClientParsedFile {
  name: string;
  fileType: 'CSV' | 'XLSX';
  columns: string[];
  rows: DataRow[];
}

export function createSampleExcelFile(): File {
  const sampleRows: DataRow[] = [
    {
      order_id: 'ORD-5001',
      customer_name: 'Kestrel Precision ',
      currency: 'usd ',
      unit_cost: 'USD 84.50',
      order_date: '18/11/2026',
      total_amount: 1690,
    },
    {
      order_id: 'ORD-5002',
      customer_name: 'Nordic Bearings',
      currency: 'eur',
      unit_cost: 42.0,
      order_date: '2026-11-19',
      total_amount: -420,
    },
    {
      order_id: 'ORD-5002',
      customer_name: 'Nordic Bearings',
      currency: 'EUR',
      unit_cost: 42.0,
      order_date: '2026-11-19',
      total_amount: 420,
    },
    {
      order_id: 'ORD-5003',
      customer_name: null,
      currency: 'USD',
      unit_cost: '$112.00',
      order_date: '2026-11-20',
      total_amount: 2240,
    },
  ];
  const sheet = XLSX.utils.json_to_sheet(sampleRows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, 'Orders');
  const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return new File([bytes], 'sample_orders_ledger.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

export async function parseUploadedFile(file: File): Promise<ClientParsedFile> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.csv')) {
    const text = await file.text();
    const parsed = Papa.parse<Record<string, string>>(text.trim(), {
      header: true,
      skipEmptyLines: true,
    });
    const columns = (parsed.meta.fields ?? []).map((c) => c.trim()).filter(Boolean);
    const rows: DataRow[] = parsed.data.map((row) => {
      const normalized: DataRow = {};
      for (const col of columns) {
        const val = row[col];
        if (val === undefined || val === '') {
          normalized[col] = null;
        } else {
          const trimmed = val.trim();
          const isPureNumber =
            trimmed !== '' &&
            val === trimmed &&
            /^-?\d+(?:\.\d+)?$/.test(trimmed) &&
            !(trimmed.length > 1 && trimmed.startsWith('0') && !trimmed.startsWith('0.'));
          normalized[col] = isPureNumber ? Number(trimmed) : val;
        }
      }
      return normalized;
    });
    return { name: file.name, fileType: 'CSV', columns, rows };
  }

  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array' });
    const firstSheet = workbook.SheetNames[0];
    if (!firstSheet) {
      throw new Error('Excel workbook contains no readable worksheets.');
    }
    const rawRows = XLSX.utils.sheet_to_json<DataRow>(
      workbook.Sheets[firstSheet],
      { defval: null }
    );
    const columns = rawRows.length > 0 ? Object.keys(rawRows[0]) : [];
    return { name: file.name, fileType: 'XLSX', columns, rows: rawRows };
  }

  throw new Error('Unsupported file format. Please upload a .csv or .xlsx file.');
}

export function triggerTextDownload(
  filename: string,
  content: string,
  mimeType = 'text/csv;charset=utf-8;'
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
