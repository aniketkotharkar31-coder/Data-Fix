import type {
  AiDiagnosisRunResult,
  ApproveRepairSelection,
  ApproveRepairsResponse,
  AuditEntry,
  AuditModificationRecord,
  AuditModificationValidationStatus,
  DashboardSummary,
  DataQualityReportExport,
  DataRow,
  DatasetRecord,
  DetectedIssueRecord,
  DiagnosisInsight,
  ModificationHistoryEntry,
  QualityIssue,
  RepairRule,
  RepairSuggestion,
  ReportSummary,
  ValidationCheck,
  ValidationComparisonReport,
} from '../types/datafix';

export class ApiRequestError extends Error {
  readonly status?: number;
  readonly rawPreview?: string;

  constructor(message: string, status?: number, rawPreview?: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.rawPreview = rawPreview;
  }
}

async function parseJsonResponse(response: Response): Promise<{
  okJson: boolean;
  data: Record<string, unknown>;
  rawText: string;
}> {
  const rawText = await response.text();
  if (!rawText.trim()) {
    return { okJson: false, data: {}, rawText };
  }
  try {
    const parsed: unknown = JSON.parse(rawText);
    if (parsed && typeof parsed === 'object') {
      return { okJson: true, data: parsed as Record<string, unknown>, rawText };
    }
    return { okJson: false, data: {}, rawText };
  } catch {
    return { okJson: false, data: {}, rawText };
  }
}

function buildNonJsonError(
  url: string,
  response: Response,
  rawText: string
): ApiRequestError {
  const rawPreview = rawText.trim().slice(0, 200) || '(empty response body)';
  const statusLabel = response.statusText
    ? `${response.status} ${response.statusText}`
    : `${response.status}`;

  console.error('[DataFix API] Unexpected non-JSON response:', {
    url,
    status: response.status,
    statusText: response.statusText,
    contentType: response.headers.get('content-type'),
    rawPreview,
  });

  return new ApiRequestError(
    `Received an unexpected non-JSON response from ${url} (HTTP ${statusLabel}). Raw response preview: ${rawPreview}`,
    response.status,
    rawPreview
  );
}

function extractDatasetFromPayload(
  payload: Record<string, unknown>
): DatasetRecord | undefined {
  const nested = payload?.dataset as DatasetRecord | undefined;
  if (nested && typeof nested === 'object' && typeof nested.id === 'string' && nested.id) {
    return nested;
  }
  if (
    typeof payload?.id === 'string' &&
    payload.id &&
    typeof payload?.name === 'string'
  ) {
    return payload as unknown as DatasetRecord;
  }
  return undefined;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  const { okJson, data: payload, rawText } = await parseJsonResponse(response);
  if (!response.ok) {
    if (okJson && typeof payload?.error === 'string' && payload.error.trim().length > 0) {
      throw new ApiRequestError(payload.error, response.status);
    }
    if (!okJson) {
      throw buildNonJsonError(url, response, rawText);
    }
    throw new ApiRequestError(
      `Request to ${url} failed with HTTP ${response.status}.`,
      response.status
    );
  }
  if (!okJson) {
    throw buildNonJsonError(url, response, rawText);
  }
  return payload as T;
}

export const datafixApi = {
  getDashboard(): Promise<DashboardSummary> {
    return requestJson<DashboardSummary>('/api/dashboard');
  },

  getDatasets(): Promise<{ datasets: DatasetRecord[] }> {
    return requestJson<{ datasets: DatasetRecord[] }>('/api/datasets');
  },

  async createDataset(payload: {
    name: string;
    fileType: 'CSV' | 'XLSX';
    fileSizeBytes?: number;
    columns: string[];
    rows: DataRow[];
  }): Promise<{
    dataset: DatasetRecord;
    issuesDetected: QualityIssue[];
    repairsGenerated: RepairRule[];
  }> {
    const result = await requestJson<Record<string, unknown>>('/api/datasets', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const dataset = extractDatasetFromPayload(result);
    if (!dataset?.id) {
      throw new ApiRequestError(
        'Dataset creation succeeded but the backend response did not include an initialized dataset record.'
      );
    }
    return {
      dataset,
      issuesDetected: Array.isArray(result.issuesDetected)
        ? (result.issuesDetected as QualityIssue[])
        : [],
      repairsGenerated: Array.isArray(result.repairsGenerated)
        ? (result.repairsGenerated as RepairRule[])
        : [],
    };
  },

  async uploadDatasetFile(file: File): Promise<{
    dataset: DatasetRecord;
    issuesDetected: QualityIssue[];
    repairsGenerated: RepairRule[];
  }> {
    const url = '/api/datasets/upload';
    const formData = new FormData();
    formData.append('file', file);

    const response = await fetch(url, {
      method: 'POST',
      body: formData,
    });

    const { okJson, data: payload, rawText } = await parseJsonResponse(response);
    if (!response.ok) {
      if (okJson && typeof payload?.error === 'string' && payload.error.trim().length > 0) {
        throw new ApiRequestError(payload.error, response.status);
      }
      if (!okJson) {
        throw buildNonJsonError(url, response, rawText);
      }
      throw new ApiRequestError(`Upload failed with HTTP ${response.status}.`, response.status);
    }

    if (!okJson) {
      throw buildNonJsonError(url, response, rawText);
    }

    const dataset = extractDatasetFromPayload(payload);
    if (!dataset?.id) {
      throw new ApiRequestError(
        'Upload completed but the backend did not return an initialized dataset record.'
      );
    }

    return {
      dataset,
      issuesDetected: Array.isArray(payload.issuesDetected)
        ? (payload.issuesDetected as QualityIssue[])
        : [],
      repairsGenerated: Array.isArray(payload.repairsGenerated)
        ? (payload.repairsGenerated as RepairRule[])
        : [],
    };
  },

  getDatasetAnalysis(datasetId: string): Promise<{
    dataset: DatasetRecord;
    analysis: Record<string, unknown>;
    originalRowCount: number;
  }> {
    return requestJson(`/api/datasets/${encodeURIComponent(datasetId)}/analysis`);
  },

  deleteDataset(datasetId: string): Promise<{ deletedId: string }> {
    return requestJson(`/api/datasets/${encodeURIComponent(datasetId)}`, {
      method: 'DELETE',
    });
  },

  scanDataset(datasetId: string): Promise<{
    dataset: DatasetRecord;
    issues: QualityIssue[];
    repairs: RepairRule[];
  }> {
    return requestJson(`/api/datasets/${encodeURIComponent(datasetId)}/scan`, {
      method: 'POST',
    });
  },

  resetDataset(datasetId: string): Promise<{
    dataset: DatasetRecord;
    repairs: RepairRule[];
  }> {
    return requestJson(`/api/datasets/${encodeURIComponent(datasetId)}/reset`, {
      method: 'POST',
    });
  },

  getIssues(datasetId?: string): Promise<{
    issues: QualityIssue[];
    detailedIssues: DetectedIssueRecord[];
  }> {
    const query = datasetId ? `?datasetId=${encodeURIComponent(datasetId)}` : '';
    return requestJson<{
      issues: QualityIssue[];
      detailedIssues: DetectedIssueRecord[];
    }>(`/api/issues${query}`);
  },

  getDiagnosis(datasetId?: string): Promise<{
    diagnoses: DiagnosisInsight[];
    geminiConfigured: boolean;
    model: string;
  }> {
    const query = datasetId ? `?datasetId=${encodeURIComponent(datasetId)}` : '';
    return requestJson(`/api/diagnosis${query}`);
  },

  runGeminiDiagnosis(datasetId: string): Promise<AiDiagnosisRunResult> {
    return requestJson<AiDiagnosisRunResult>(
      `/api/datasets/${encodeURIComponent(datasetId)}/diagnosis`,
      {
        method: 'POST',
      }
    );
  },

  getRepairs(datasetId?: string): Promise<{
    repairs: RepairRule[];
    suggestions: RepairSuggestion[];
    modificationHistory: ModificationHistoryEntry[];
  }> {
    const query = datasetId ? `?datasetId=${encodeURIComponent(datasetId)}` : '';
    return requestJson<{
      repairs: RepairRule[];
      suggestions: RepairSuggestion[];
      modificationHistory: ModificationHistoryEntry[];
    }>(`/api/repairs${query}`);
  },

  approveRepairs(
    datasetId: string,
    approvals: ApproveRepairSelection[]
  ): Promise<ApproveRepairsResponse> {
    return requestJson<ApproveRepairsResponse>(
      `/api/datasets/${encodeURIComponent(datasetId)}/repairs/approve`,
      {
        method: 'POST',
        body: JSON.stringify({ approvals }),
      }
    );
  },

  applyRepairs(ruleIds: string[]): Promise<{
    appliedRuleIds: string[];
    affectedTotal: number;
    repairs: RepairRule[];
  }> {
    return requestJson('/api/repairs/apply', {
      method: 'POST',
      body: JSON.stringify({ ruleIds }),
    });
  },

  getValidations(datasetId?: string): Promise<{
    validations: ValidationCheck[];
    reports: ValidationComparisonReport[];
  }> {
    const query = datasetId ? `?datasetId=${encodeURIComponent(datasetId)}` : '';
    return requestJson<{
      validations: ValidationCheck[];
      reports: ValidationComparisonReport[];
    }>(`/api/validations${query}`);
  },

  validateDataset(datasetId: string): Promise<{
    dataset: DatasetRecord;
    allPassed: boolean;
    validations: ValidationCheck[];
    report: ValidationComparisonReport;
  }> {
    return requestJson(`/api/datasets/${encodeURIComponent(datasetId)}/validate`, {
      method: 'POST',
    });
  },

  getExportUrl(datasetId: string, format: 'csv' | 'xlsx'): string {
    return `/api/datasets/${encodeURIComponent(datasetId)}/export?format=${format}`;
  },

  getDatasetQualityReport(
    datasetId: string
  ): Promise<{ report: DataQualityReportExport }> {
    return requestJson<{ report: DataQualityReportExport }>(
      `/api/datasets/${encodeURIComponent(datasetId)}/quality-report`
    );
  },

  getQualityReportExportUrl(
    datasetId: string,
    format: 'xlsx' | 'csv' | 'json' = 'xlsx'
  ): string {
    return `/api/datasets/${encodeURIComponent(datasetId)}/export/quality-report?format=${format}`;
  },

  getDatasetModificationsExportUrl(
    datasetId: string,
    format: 'xlsx' | 'csv' = 'xlsx'
  ): string {
    return `/api/datasets/${encodeURIComponent(datasetId)}/export/modifications?format=${format}`;
  },

  getAuditHistory(): Promise<{
    audits: AuditEntry[];
    modifications: AuditModificationRecord[];
    totalModifications: number;
  }> {
    return requestJson<{
      audits: AuditEntry[];
      modifications: AuditModificationRecord[];
      totalModifications: number;
    }>('/api/audit');
  },

  getAuditExportUrl(params: {
    format: 'csv' | 'xlsx' | 'json';
    datasetId?: string;
    column?: string;
    repairMethod?: string;
    validationStatus?: 'All' | AuditModificationValidationStatus;
    q?: string;
  }): string {
    const search = new URLSearchParams();
    search.set('format', params.format);
    if (params.datasetId && params.datasetId !== 'ALL') {
      search.set('datasetId', params.datasetId);
    }
    if (params.column && params.column !== 'ALL') {
      search.set('column', params.column);
    }
    if (params.repairMethod && params.repairMethod !== 'ALL') {
      search.set('repairMethod', params.repairMethod);
    }
    if (params.validationStatus && params.validationStatus !== 'All') {
      search.set('validationStatus', params.validationStatus);
    }
    if (params.q && params.q.trim().length > 0) {
      search.set('q', params.q.trim());
    }
    return `/api/audit/export?${search.toString()}`;
  },

  getReports(): Promise<{ reports: ReportSummary[] }> {
    return requestJson<{ reports: ReportSummary[] }>('/api/reports');
  },

  generateReport(
    datasetId: string,
    format: 'XLSX' | 'CSV' | 'JSON'
  ): Promise<{ report: ReportSummary }> {
    return requestJson('/api/reports/generate', {
      method: 'POST',
      body: JSON.stringify({ datasetId, format }),
    });
  },
};
