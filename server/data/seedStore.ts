import type {
  AuditEntry,
  AuditModificationRecord,
  DataRow,
  DatasetRecord,
  DetectedIssueRecord,
  DiagnosisInsight,
  ModificationHistoryEntry,
  QualityIssue,
  QualityTrendPoint,
  RepairRule,
  RepairSuggestion,
  ReportSummary,
  ValidationCheck,
  ValidationComparisonReport,
} from '../../src/types/datafix.ts';
import {
  generateRepairRules,
  type DimensionScores,
} from '../services/dataEngine.ts';
import { analyzeDataset } from '../engine/datasetAnalyzer.ts';
import { generateRepairSuggestions } from '../engine/repairEngine.ts';
import { validateDatasetRepairs } from '../engine/validationEngine.ts';
import type { DatasetAnalysisResult } from '../engine/types.ts';

export interface StoredDatasetPayload {
  rawRows: DataRow[];
  currentRows: DataRow[];
  baselineDimensions: DimensionScores;
  baselineScore: number;
  baselineAnalysis: DatasetAnalysisResult;
  repairBatches: ModificationHistoryEntry[][];
  originalFileBuffer?: Buffer;
  analysis?: DatasetAnalysisResult;
}

export interface DataFixStore {
  datasets: DatasetRecord[];
  datasetPayloads: Map<string, StoredDatasetPayload>;
  issues: QualityIssue[];
  detailedIssues: DetectedIssueRecord[];
  diagnoses: DiagnosisInsight[];
  repairs: RepairRule[];
  repairSuggestions: RepairSuggestion[];
  modificationHistory: ModificationHistoryEntry[];
  validations: ValidationCheck[];
  validationReports: ValidationComparisonReport[];
  audits: AuditEntry[];
  auditModifications: AuditModificationRecord[];
  reports: ReportSummary[];
  trends: QualityTrendPoint[];
}

function buildSeededDataset(params: {
  id: string;
  name: string;
  fileType: 'CSV' | 'XLSX';
  uploadedAt: string;
  columns: string[];
  rows: DataRow[];
  initialRepairedCells?: number;
  forceValidated?: boolean;
}) {
  const analysis = analyzeDataset({
    filename: params.name,
    fileType: params.fileType,
    columns: params.columns,
    rows: params.rows,
  });
  const issues: QualityIssue[] = analysis.issues.map((item, idx) => ({
    ...item,
    id: `iss-${params.id}-${idx + 1}`,
    datasetId: params.id,
  }));
  const detailedIssues: DetectedIssueRecord[] = analysis.detailedIssues.map(
    (item, idx) => ({
      ...item,
      id: `det-${params.id}-${idx + 1}`,
      datasetId: params.id,
      datasetName: params.name,
    })
  );

  const repairs = generateRepairRules(
    params.id,
    params.columns,
    params.rows,
    issues
  );
  const repairSuggestions = generateRepairSuggestions(
    params.id,
    params.name,
    analysis,
    params.rows
  );
  const { report: validationReport } = validateDatasetRepairs({
    datasetId: params.id,
    datasetName: params.name,
    fileType: params.fileType,
    columns: params.columns,
    originalRows: params.rows,
    currentRows: params.rows,
    originalAnalysis: analysis,
    repairBatches: [],
    validatedAt: params.uploadedAt,
  });
  const validations = validationReport.checks;

  const record: DatasetRecord = {
    id: params.id,
    name: params.name,
    fileType: params.fileType,
    rows: params.rows.length,
    columns: params.columns.length,
    columnNames: params.columns,
    qualityScore: analysis.qualityScore.overallScore,
    previousScore: analysis.qualityScore.overallScore,
    openIssues: issues.length,
    repairedCells: params.initialRepairedCells ?? 0,
    status: params.forceValidated
      ? 'Validated'
      : issues.length > 0
        ? 'Needs Review'
        : 'Validated',
    uploadedAt: params.uploadedAt,
    previewRows: params.rows.slice(0, 20),
    originalPreviewRows: params.rows.slice(0, 20).map((r) => ({ ...r })),
    isDemo: true,
  };

  const payload: StoredDatasetPayload = {
    rawRows: params.rows.map((r) => ({ ...r })),
    currentRows: params.rows.map((r) => ({ ...r })),
    baselineDimensions: analysis.dimensions,
    baselineScore: analysis.qualityScore.overallScore,
    baselineAnalysis: analysis,
    repairBatches: [],
    analysis,
  };

  return {
    record,
    payload,
    issues,
    detailedIssues,
    repairs,
    repairSuggestions,
    validations,
    validationReport,
  };
}

export function createInitialStore(): DataFixStore {
  const seed1 = buildSeededDataset({
    id: 'ds-001',
    name: 'enterprise_customers_q4.csv',
    fileType: 'CSV',
    uploadedAt: '2026-11-18 09:14',
    columns: [
      'customer_id',
      'account_name',
      'contact_email',
      'country_code',
      'annual_contract_usd',
      'renewal_date',
    ],
    rows: [
      {
        customer_id: 'CUS-1041',
        account_name: 'Northbridge Logistics',
        contact_email: 'ops@northbridge.io',
        country_code: 'US',
        annual_contract_usd: 142000,
        renewal_date: '2027-01-15',
      },
      {
        customer_id: 'CUS-1042',
        account_name: 'Helios Manufacturing',
        contact_email: null,
        country_code: 'uk',
        annual_contract_usd: 96500,
        renewal_date: '15/03/2027',
      },
      {
        customer_id: 'CUS-1042',
        account_name: 'Helios Manufacturing',
        contact_email: 'billing@helios-mfg.co.uk',
        country_code: 'GB',
        annual_contract_usd: 96500,
        renewal_date: '2027-03-15',
      },
      {
        customer_id: 'CUS-1043',
        account_name: 'Meridian Freight Corp',
        contact_email: 'finance@meridianfreight.com',
        country_code: 'CA',
        annual_contract_usd: -4500,
        renewal_date: '2027-04-01',
      },
      {
        customer_id: 'CUS-1044',
        account_name: ' Solaris Biotech ',
        contact_email: 'ap@solarisbio.de',
        country_code: 'de',
        annual_contract_usd: 218000,
        renewal_date: '22/05/2027',
      },
      {
        customer_id: 'CUS-1045',
        account_name: 'Atlas Maritime Group',
        contact_email: null,
        country_code: 'SG',
        annual_contract_usd: 114200,
        renewal_date: '2027-06-30',
      },
      {
        customer_id: 'CUS-1046',
        account_name: 'Kestrel Precision Ltd',
        contact_email: 'accounts@kestrel-uk.com',
        country_code: 'uk',
        annual_contract_usd: 88400,
        renewal_date: '2027-07-12',
      },
      {
        customer_id: 'CUS-1047',
        account_name: 'Redwood Cloud Systems',
        contact_email: 'billing@redwoodcloud.io',
        country_code: 'US',
        annual_contract_usd: 165000,
        renewal_date: '2027-08-01',
      },
    ],
  });

  const seed2 = buildSeededDataset({
    id: 'ds-002',
    name: 'supply_chain_ledger.xlsx',
    fileType: 'XLSX',
    uploadedAt: '2026-11-17 16:40',
    columns: [
      'shipment_id',
      'warehouse_code',
      'sku_code',
      'unit_cost',
      'dispatch_date',
      'carrier',
    ],
    rows: [
      {
        shipment_id: 'SHP-88410',
        warehouse_code: 'WH-ROT-02',
        sku_code: 'SKU-4019',
        unit_cost: 'USD 42.80',
        dispatch_date: '2026-11-10',
        carrier: 'Maersk Line',
      },
      {
        shipment_id: 'SHP-88411',
        warehouse_code: 'WH-SIN-01',
        sku_code: 'SKU-4022',
        unit_cost: 19.5,
        dispatch_date: '11/11/2026',
        carrier: null,
      },
      {
        shipment_id: 'SHP-88412',
        warehouse_code: 'WH-HAM-04',
        sku_code: 'SKU-4090',
        unit_cost: 'USD 64.25',
        dispatch_date: '2026-11-12',
        carrier: 'Hapag-Lloyd',
      },
      {
        shipment_id: 'SHP-88413',
        warehouse_code: 'WH-LAX-01',
        sku_code: 'SKU-4105',
        unit_cost: 31.0,
        dispatch_date: '2026-11-13',
        carrier: 'Maersk Line',
      },
      {
        shipment_id: 'SHP-88414',
        warehouse_code: 'WH-SIN-01',
        sku_code: 'SKU-4110',
        unit_cost: 27.4,
        dispatch_date: '2026-11-14',
        carrier: null,
      },
    ],
  });

  const seed3 = buildSeededDataset({
    id: 'ds-003',
    name: 'clinical_intake_registry.csv',
    fileType: 'CSV',
    uploadedAt: '2026-11-16 11:25',
    columns: [
      'subject_id',
      'site_code',
      'age_years',
      'intake_date',
      'cohort',
      'consent_flag',
    ],
    rows: [
      {
        subject_id: 'SUB-2091',
        site_code: 'BOS-01',
        age_years: 44,
        intake_date: '2026-10-28',
        cohort: 'Arm-A',
        consent_flag: 'Y',
      },
      {
        subject_id: 'SUB-2092',
        site_code: 'ZUR-03',
        age_years: 51,
        intake_date: '2026-10-29',
        cohort: 'Arm-B',
        consent_flag: 'Y',
      },
      {
        subject_id: 'SUB-2093',
        site_code: 'LDN-02',
        age_years: 38,
        intake_date: '2026-10-30',
        cohort: 'Arm-A',
        consent_flag: 'Y',
      },
      {
        subject_id: 'SUB-2094',
        site_code: 'TOR-01',
        age_years: 62,
        intake_date: '2026-11-01',
        cohort: 'Arm-B',
        consent_flag: 'Y',
      },
    ],
    initialRepairedCells: 18,
    forceValidated: true,
  });

  const seed4 = buildSeededDataset({
    id: 'ds-004',
    name: 'vendor_invoices_2026.xlsx',
    fileType: 'XLSX',
    uploadedAt: '2026-11-18 14:05',
    columns: [
      'invoice_no',
      'vendor_name',
      'currency',
      'net_amount',
      'due_date',
      'approval_state',
    ],
    rows: [
      {
        invoice_no: 'INV-90211',
        vendor_name: 'Kestrel Precision Ltd',
        currency: 'usd ',
        net_amount: 18450,
        due_date: '2026-12-01',
        approval_state: 'Pending',
      },
      {
        invoice_no: 'INV-90211',
        vendor_name: 'Kestrel Precision Ltd',
        currency: 'USD',
        net_amount: 18450,
        due_date: '2026-12-01',
        approval_state: 'Approved',
      },
      {
        invoice_no: 'INV-90212',
        vendor_name: 'Nordic Bearings AB',
        currency: 'eur',
        net_amount: -1200,
        due_date: '14/12/2026',
        approval_state: 'Pending',
      },
      {
        invoice_no: 'INV-90213',
        vendor_name: 'Apex Components',
        currency: 'USD',
        net_amount: '$9,450.00',
        due_date: '2026-12-20',
        approval_state: 'Approved',
      },
    ],
  });

  const seeds = [seed1, seed2, seed3, seed4];
  const datasetPayloads = new Map<string, StoredDatasetPayload>();
  for (const s of seeds) {
    datasetPayloads.set(s.record.id, s.payload);
  }

  const diagnoses: DiagnosisInsight[] = [
    {
      id: 'diag-1',
      datasetId: 'ds-001',
      column: 'renewal_date',
      rootCause:
        'Regional CRM exports from UK and EU sales teams serialize dates as DD/MM/YYYY instead of ISO-8601.',
      businessImpact:
        'Automated renewal forecasting skips affected accounts when date parsing fails downstream.',
      recommendedAction:
        'Normalize mixed regional date strings to canonical YYYY-MM-DD and retain parse audit trail.',
      confidenceLabel: 'High',
      source: 'Baseline Profile',
    },
    {
      id: 'diag-2',
      datasetId: 'ds-001',
      column: 'customer_id',
      rootCause:
        'Concurrent ERP backfill created duplicate account snapshots where secondary rows hold updated contact emails.',
      businessImpact:
        'Double-counted ARR totals and broken relational joins in reporting warehouses.',
      recommendedAction:
        'Merge duplicate customer_id records by retaining the most complete non-null contact row.',
      confidenceLabel: 'High',
      source: 'Baseline Profile',
    },
    {
      id: 'diag-3',
      datasetId: 'ds-002',
      column: 'unit_cost',
      rootCause:
        'Excel workbook sheets imported currency-prefixed text strings ("USD 42.80") into numeric columns.',
      businessImpact:
        'Prevents automated margin aggregations and inventory valuation rollups.',
      recommendedAction:
        'Strip ISO currency prefixes, trim whitespace, and coerce values to two-decimal floats.',
      confidenceLabel: 'High',
      source: 'Baseline Profile',
    },
  ];

  const audits: AuditEntry[] = [
    {
      id: 'aud-01',
      timestamp: '2026-11-18 14:05',
      datasetName: 'vendor_invoices_2026.xlsx',
      stage: 'Upload',
      action: `Parsed ${seed4.record.rows} rows via SheetJS workbook reader (${seed4.record.openIssues} issues flagged)`,
      actor: 'DataFix Ingest',
      outcome: 'Flagged',
    },
    {
      id: 'aud-02',
      timestamp: '2026-11-18 10:22',
      datasetName: 'enterprise_customers_q4.csv',
      stage: 'Detect',
      action: `Flagged ${seed1.record.openIssues} schema, completeness, and format anomalies`,
      actor: 'Rule Engine',
      outcome: 'Flagged',
    },
    {
      id: 'aud-03',
      timestamp: '2026-11-17 17:12',
      datasetName: 'supply_chain_ledger.xlsx',
      stage: 'Detect',
      action: `Generated ${seed2.repairs.length} deterministic repair rules for staged review`,
      actor: 'Repair Planner',
      outcome: 'Queued',
    },
    {
      id: 'aud-04',
      timestamp: '2026-11-16 14:48',
      datasetName: 'clinical_intake_registry.csv',
      stage: 'Validation',
      action: 'Passed all completeness, schema, and uniqueness gates (100.0%)',
      actor: 'Validation Gate',
      outcome: 'Completed',
    },
  ];

  const reports: ReportSummary[] = [
    {
      id: 'rpt-01',
      title: 'Q4 Customer CRM Quality Baseline',
      datasetId: seed1.record.id,
      datasetName: seed1.record.name,
      generatedAt: '2026-11-18 11:00',
      qualityScore: seed1.record.qualityScore,
      issuesResolved: 0,
      openIssues: seed1.record.openIssues,
      format: 'CSV',
    },
    {
      id: 'rpt-02',
      title: 'Supply Chain Ledger Profiling Summary',
      datasetId: seed2.record.id,
      datasetName: seed2.record.name,
      generatedAt: '2026-11-17 18:15',
      qualityScore: seed2.record.qualityScore,
      issuesResolved: 0,
      openIssues: seed2.record.openIssues,
      format: 'JSON',
    },
    {
      id: 'rpt-03',
      title: 'Clinical Registry Validation Certificate',
      datasetId: seed3.record.id,
      datasetName: seed3.record.name,
      generatedAt: '2026-11-16 15:10',
      qualityScore: seed3.record.qualityScore,
      issuesResolved: 18,
      openIssues: 0,
      format: 'CSV',
    },
  ];

  const trends: QualityTrendPoint[] = [
    { period: 'Nov 12', qualityScore: 76.4, issuesDetected: 28, recordsRepaired: 12 },
    { period: 'Nov 13', qualityScore: 79.1, issuesDetected: 24, recordsRepaired: 18 },
    { period: 'Nov 14', qualityScore: 82.8, issuesDetected: 19, recordsRepaired: 25 },
    { period: 'Nov 15', qualityScore: 85.2, issuesDetected: 16, recordsRepaired: 31 },
    { period: 'Nov 16', qualityScore: 88.6, issuesDetected: 14, recordsRepaired: 39 },
    { period: 'Nov 17', qualityScore: 90.1, issuesDetected: 12, recordsRepaired: 46 },
    { period: 'Nov 18', qualityScore: 91.8, issuesDetected: 10, recordsRepaired: 54 },
  ];

  return {
    datasets: seeds.map((s) => s.record),
    datasetPayloads,
    issues: seeds.flatMap((s) => s.issues),
    detailedIssues: seeds.flatMap((s) => s.detailedIssues),
    diagnoses,
    repairs: seeds.flatMap((s) => s.repairs),
    repairSuggestions: seeds.flatMap((s) => s.repairSuggestions),
    modificationHistory: [],
    validations: seeds.flatMap((s) => s.validations),
    validationReports: seeds.map((s) => s.validationReport),
    audits,
    auditModifications: [],
    reports,
    trends,
  };
}
