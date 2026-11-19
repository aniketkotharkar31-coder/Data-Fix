import { Router, type NextFunction, type Request, type Response } from 'express';
import multer, { MulterError } from 'multer';
import {
  DEFAULT_GEMINI_MODEL,
  isGeminiConfigured,
} from '../config/gemini.ts';
import {
  GeminiDiagnosisError,
  diagnoseDetectedIssues,
} from '../services/aiDiagnosisService.ts';
import { createInitialStore } from '../data/seedStore.ts';
import {
  DEFAULT_MAX_FILE_BYTES,
  DatasetProcessingError,
  analyzeDataset,
  applyApprovedRepairSuggestions,
  buildAuditReportJson,
  buildCleanedCsvExport,
  buildCleanedExcelExport,
  buildDataQualityReportCsv,
  buildDataQualityReportExcel,
  buildDataQualityReportPayload,
  buildModificationHistoryCsv,
  buildModificationHistoryExcel,
  filterAuditModifications,
  generateRepairSuggestions,
  markDatasetAuditModificationsReverted,
  readDataset,
  recordApprovedModifications,
  syncAuditValidationStatuses,
  validateDatasetRepairs,
} from '../engine/index.ts';
import {
  applyRepairRulesToRows,
  computeDashboardMetrics,
  generateRepairRules,
  parseCsvString,
} from '../services/dataEngine.ts';
import type {
  ApproveRepairSelection,
  AuditModificationValidationStatus,
  DashboardSummary,
  DataRow,
  DatasetRecord,
  DetectedIssueRecord,
  ModificationHistoryEntry,
  QualityIssue,
  ReportSummary,
} from '../../src/types/datafix.ts';

function formatTimestamp(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

export function createApiRouter(): Router {
  const router = Router();
  const store = createInitialStore();
  let idSeq = 0;
  const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++idSeq}`;
  const uploadMiddleware = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: DEFAULT_MAX_FILE_BYTES,
      files: 1,
    },
  });

  function refreshDatasetArtifacts(
    dataset: DatasetRecord,
    options?: { resetBaseline?: boolean }
  ) {
    const payload = store.datasetPayloads.get(dataset.id);
    if (!payload) return null;

    if (options?.resetBaseline) {
      payload.repairBatches = [];
    }

    const { report: validationReport, updatedAnalysis: analysis } =
      validateDatasetRepairs({
        datasetId: dataset.id,
        datasetName: dataset.name,
        fileType: dataset.fileType,
        fileSizeBytes: dataset.fileSizeBytes,
        columns: dataset.columnNames,
        originalRows: payload.rawRows,
        currentRows: payload.currentRows,
        originalAnalysis: options?.resetBaseline
          ? undefined
          : payload.baselineAnalysis,
        repairBatches: payload.repairBatches,
      });

    payload.analysis = analysis;

    if (options?.resetBaseline) {
      payload.baselineAnalysis = analysis;
      payload.baselineDimensions = analysis.dimensions;
      payload.baselineScore = analysis.qualityScore.overallScore;
    }

    dataset.rows = payload.currentRows.length;
    dataset.qualityScore = analysis.qualityScore.overallScore;
    dataset.openIssues = analysis.issues.length;
    dataset.previewRows = payload.currentRows.slice(0, 20);

    const newIssues: QualityIssue[] = analysis.issues.map((issue, idx) => ({
      ...issue,
      id: `iss-${dataset.id}-${idx + 1}`,
      datasetId: dataset.id,
    }));

    const newDetailedIssues: DetectedIssueRecord[] = analysis.detailedIssues.map(
      (item, idx) => ({
        ...item,
        id: `det-${dataset.id}-${idx + 1}`,
        datasetId: dataset.id,
        datasetName: dataset.name,
      })
    );

    store.issues = [
      ...newIssues,
      ...store.issues.filter((item) => item.datasetId !== dataset.id),
    ];

    store.detailedIssues = [
      ...newDetailedIssues,
      ...store.detailedIssues.filter((item) => item.datasetId !== dataset.id),
    ];

    // Keep Gemini AI diagnoses synchronized with current open issues (never show stale repaired issues)
    if (options?.resetBaseline) {
      store.diagnoses = store.diagnoses.filter(
        (d) => !(d.datasetId === dataset.id && d.source === 'Gemini AI')
      );
    } else {
      const survivingIssueMap = new Map<string, DetectedIssueRecord[]>();
      for (const det of newDetailedIssues) {
        const key = `${det.issueType}::${det.column}::${det.originalValue}`;
        const list = survivingIssueMap.get(key) ?? [];
        list.push(det);
        survivingIssueMap.set(key, list);
      }

      store.diagnoses = store.diagnoses.flatMap((diag) => {
        if (diag.datasetId !== dataset.id || diag.source !== 'Gemini AI') {
          return [diag];
        }
        const actual = diag.actualFinding;
        if (!actual) return [];
        const key = `${actual.issueType}::${actual.column}::${actual.originalValue}`;
        const candidates = survivingIssueMap.get(key);
        if (!candidates || candidates.length === 0) {
          return [];
        }
        const matched = candidates.shift()!;
        return [
          {
            ...diag,
            issueId: matched.id,
            actualFinding: {
              ...actual,
              issueId: matched.id,
              rowNumber: matched.rowNumber,
              description: matched.description,
              engineSuggestedAction: matched.suggestedAction,
            },
          },
        ];
      });
    }

    const newRepairSuggestions = generateRepairSuggestions(
      dataset.id,
      dataset.name,
      analysis,
      payload.currentRows
    );
    store.repairSuggestions = [
      ...newRepairSuggestions,
      ...store.repairSuggestions.filter((item) => item.datasetId !== dataset.id),
    ];

    const newValidations = validationReport.checks;
    store.validations = [
      ...newValidations,
      ...store.validations.filter((v) => v.datasetId !== dataset.id),
    ];

    store.validationReports = [
      validationReport,
      ...store.validationReports.filter((r) => r.datasetId !== dataset.id),
    ];

    return {
      analysis,
      newIssues,
      newDetailedIssues,
      newRepairSuggestions,
      newValidations,
      validationReport,
    };
  }

  function buildDatasetQualityReport(dataset: DatasetRecord) {
    const payload = store.datasetPayloads.get(dataset.id);
    if (!payload) return null;

    const currentAnalysis =
      payload.analysis ??
      analyzeDataset({
        filename: dataset.name,
        fileType: dataset.fileType,
        fileSizeBytes: dataset.fileSizeBytes,
        columns: dataset.columnNames,
        rows: payload.currentRows,
      });
    payload.analysis = currentAnalysis;

    const originalAnalysis =
      payload.baselineAnalysis ??
      analyzeDataset({
        filename: dataset.name,
        fileType: dataset.fileType,
        fileSizeBytes: dataset.fileSizeBytes,
        columns: dataset.columnNames,
        rows: payload.rawRows,
      });
    payload.baselineAnalysis = originalAnalysis;

    let validationReport = store.validationReports.find(
      (r) => r.datasetId === dataset.id
    );
    if (!validationReport) {
      const validated = validateDatasetRepairs({
        datasetId: dataset.id,
        datasetName: dataset.name,
        fileType: dataset.fileType,
        fileSizeBytes: dataset.fileSizeBytes,
        columns: dataset.columnNames,
        originalRows: payload.rawRows,
        currentRows: payload.currentRows,
        originalAnalysis,
        repairBatches: payload.repairBatches,
      });
      validationReport = validated.report;
      store.validationReports = [
        validationReport,
        ...store.validationReports.filter((r) => r.datasetId !== dataset.id),
      ];
    }

    return buildDataQualityReportPayload({
      dataset,
      originalAnalysis,
      currentAnalysis,
      validationReport,
      auditModifications: store.auditModifications,
    });
  }

  function registerAnalyzedDataset(params: {
    name: string;
    fileType: 'CSV' | 'XLSX';
    fileSizeBytes?: number;
    columns: string[];
    rows: DataRow[];
    originalFileBuffer?: Buffer;
    truncated?: boolean;
  }) {
    const analysis = analyzeDataset({
      filename: params.name,
      fileType: params.fileType,
      fileSizeBytes: params.fileSizeBytes,
      columns: params.columns,
      rows: params.rows,
      truncated: params.truncated,
    });

    const id = nextId('ds');
    const nowFormatted = formatTimestamp();

    const newDataset: DatasetRecord = {
      id,
      name: params.name,
      fileType: params.fileType,
      rows: params.rows.length,
      columns: params.columns.length,
      columnNames: [...params.columns],
      qualityScore: analysis.qualityScore.overallScore,
      previousScore: analysis.qualityScore.overallScore,
      openIssues: analysis.issues.length,
      repairedCells: 0,
      status: analysis.issues.length > 0 ? 'Needs Review' : 'Validated',
      uploadedAt: nowFormatted,
      previewRows: params.rows.slice(0, 20).map((r) => ({ ...r })),
      originalPreviewRows: params.rows.slice(0, 20).map((r) => ({ ...r })),
      fileSizeBytes: params.fileSizeBytes,
      isDemo: false,
    };

    store.datasets.unshift(newDataset);
    store.datasetPayloads.set(id, {
      rawRows: params.rows.map((r) => ({ ...r })),
      currentRows: params.rows.map((r) => ({ ...r })),
      baselineDimensions: analysis.dimensions,
      baselineScore: analysis.qualityScore.overallScore,
      baselineAnalysis: analysis,
      repairBatches: [],
      originalFileBuffer: params.originalFileBuffer,
      analysis,
    });

    const newIssues: QualityIssue[] = analysis.issues.map((issue, idx) => ({
      ...issue,
      id: `iss-${id}-${idx + 1}`,
      datasetId: id,
    }));
    store.issues.unshift(...newIssues);

    const newDetailedIssues: DetectedIssueRecord[] = analysis.detailedIssues.map(
      (item, idx) => ({
        ...item,
        id: `det-${id}-${idx + 1}`,
        datasetId: id,
        datasetName: newDataset.name,
      })
    );
    store.detailedIssues.unshift(...newDetailedIssues);

    const newRepairs = generateRepairRules(
      id,
      params.columns,
      params.rows,
      newIssues
    );
    store.repairs.unshift(...newRepairs);

    const newRepairSuggestions = generateRepairSuggestions(
      id,
      newDataset.name,
      analysis,
      params.rows
    );
    store.repairSuggestions.unshift(...newRepairSuggestions);

    const { report: baselineValidationReport } = validateDatasetRepairs({
      datasetId: id,
      datasetName: newDataset.name,
      fileType: params.fileType,
      fileSizeBytes: params.fileSizeBytes,
      columns: params.columns,
      originalRows: params.rows,
      currentRows: params.rows,
      originalAnalysis: analysis,
      repairBatches: [],
      validatedAt: nowFormatted,
    });
    store.validations.unshift(...baselineValidationReport.checks);
    store.validationReports.unshift(baselineValidationReport);

    store.audits.unshift({
      id: `aud-${Date.now()}`,
      timestamp: nowFormatted,
      datasetName: newDataset.name,
      stage: 'Upload',
      action: `Ingested ${newDataset.rows} rows and ${newDataset.columns} columns via Node.js engine (${analysis.issues.length} issues flagged, score ${analysis.qualityScore.overallScore.toFixed(1)}%)`,
      actor: 'Workspace Analyst',
      outcome: analysis.issues.length > 0 ? 'Flagged' : 'Completed',
    });

    return {
      dataset: newDataset,
      analysis,
      issuesDetected: newIssues,
      repairsGenerated: newRepairs,
    };
  }

  router.get('/health', (_req, res) => {
    res.json({
      service: 'DataFix API',
      status: 'ready',
      timestamp: new Date().toISOString(),
      modules: {
        csvEngine: 'PapaParse',
        excelEngine: 'SheetJS (xlsx)',
        pipelineModules: [
          'readDataset',
          'analyzeDataset',
          'detectMissingValues',
          'detectDuplicates',
          'detectInvalidFormats',
          'detectInconsistentValues',
          'detectAnomalies',
          'calculateQualityScore',
          'validateDatasetRepairs',
          'recordApprovedModifications',
          'buildCleanedExcelExport',
          'buildDataQualityReportExcel',
        ],
        aiModel: DEFAULT_GEMINI_MODEL,
        geminiConfigured: isGeminiConfigured(),
      },
      datasetsLoaded: store.datasets.length,
    });
  });

  router.get('/dashboard', (_req, res) => {
    const summary: DashboardSummary = computeDashboardMetrics(
      store.datasets,
      store.issues,
      store.trends
    );
    res.json(summary);
  });

  router.get('/datasets', (_req, res) => {
    res.json({ datasets: store.datasets });
  });

  /**
   * Direct multipart file upload route: reads the actual uploaded .csv or .xlsx file
   * server-side via readDataset() and executes analyzeDataset(), preserving the original dataset.
   */
  router.post(
    '/datasets/upload',
    uploadMiddleware.single('file'),
    (req, res) => {
      const file = req.file;
      if (!file) {
        res.status(400).json({
          error: 'No dataset file provided. Upload a .csv or .xlsx file in the "file" field.',
          code: 'INVALID_INPUT',
        });
        return;
      }

      try {
        const readResult = readDataset({
          buffer: file.buffer,
          filename: file.originalname,
          mimeType: file.mimetype,
        });

        const registered = registerAnalyzedDataset({
          name: readResult.filename,
          fileType: readResult.fileType,
          fileSizeBytes: readResult.fileSizeBytes,
          columns: readResult.columns,
          rows: readResult.rows,
          originalFileBuffer: Buffer.from(file.buffer),
          truncated: readResult.truncated,
        });

        res.status(201).json(registered);
      } catch (err) {
        if (err instanceof DatasetProcessingError) {
          res.status(err.statusCode).json({
            error: err.message,
            code: err.code,
          });
          return;
        }
        res.status(500).json({
          error:
            err instanceof Error
              ? err.message
              : 'Failed to process uploaded dataset file.',
        });
      }
    }
  );

  /**
   * Stateless server-side file analysis endpoint: reads and analyzes an uploaded file
   * via readDataset() + analyzeDataset() and returns structured JSON without modifying store.
   */
  router.post(
    '/datasets/analyze',
    uploadMiddleware.single('file'),
    (req, res) => {
      const file = req.file;
      if (!file) {
        res.status(400).json({
          error: 'No dataset file provided. Upload a .csv or .xlsx file in the "file" field.',
          code: 'INVALID_INPUT',
        });
        return;
      }

      try {
        const readResult = readDataset({
          buffer: file.buffer,
          filename: file.originalname,
          mimeType: file.mimetype,
        });
        const analysis = analyzeDataset(readResult);
        res.json({
          analysis,
          previewRows: readResult.originalRows.slice(0, 10),
        });
      } catch (err) {
        if (err instanceof DatasetProcessingError) {
          res.status(err.statusCode).json({
            error: err.message,
            code: err.code,
          });
          return;
        }
        res.status(500).json({
          error:
            err instanceof Error
              ? err.message
              : 'Failed to analyze uploaded dataset file.',
        });
      }
    }
  );

  router.get('/datasets/:id/analysis', (req, res) => {
    const dataset = store.datasets.find((d) => d.id === req.params.id);
    const payload = store.datasetPayloads.get(req.params.id);
    if (!dataset || !payload) {
      res.status(404).json({ error: 'Dataset not found.' });
      return;
    }

    const analysis =
      payload.analysis ??
      analyzeDataset({
        filename: dataset.name,
        fileType: dataset.fileType,
        fileSizeBytes: dataset.fileSizeBytes,
        columns: dataset.columnNames,
        rows: payload.currentRows,
      });
    payload.analysis = analysis;

    res.json({
      dataset,
      analysis,
      originalRowCount: payload.rawRows.length,
    });
  });

  router.post('/datasets', (req, res) => {
    const {
      name,
      fileType,
      fileSizeBytes,
      columns,
      rows,
      csvText,
    }: {
      name?: string;
      fileType?: 'CSV' | 'XLSX';
      fileSizeBytes?: number;
      columns?: string[];
      rows?: DataRow[];
      csvText?: string;
    } = req.body ?? {};

    if (!name || typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'A valid dataset filename is required.' });
      return;
    }

    const trimmedName = name.trim();
    const lowerName = trimmedName.toLowerCase();
    if (!lowerName.endsWith('.csv') && !lowerName.endsWith('.xlsx')) {
      res.status(400).json({
        error: 'Unsupported file type. Only CSV (.csv) and Excel (.xlsx) files are supported.',
      });
      return;
    }

    let parsedColumns = Array.isArray(columns) ? columns : [];
    let parsedRows: DataRow[] = Array.isArray(rows) ? rows : [];

    if (typeof csvText === 'string' && csvText.trim().length > 0) {
      const parsed = parseCsvString(csvText);
      parsedColumns = parsed.columns;
      parsedRows = parsed.rows;
    }

    if (parsedColumns.length === 0 || parsedRows.length === 0) {
      res.status(400).json({
        error: 'Dataset must contain at least one column and one data row.',
      });
      return;
    }

    const cappedRows = parsedRows.slice(0, 50000);
    const registered = registerAnalyzedDataset({
      name: trimmedName,
      fileType: fileType === 'XLSX' || lowerName.endsWith('.xlsx') ? 'XLSX' : 'CSV',
      fileSizeBytes:
        typeof fileSizeBytes === 'number' && Number.isFinite(fileSizeBytes) && fileSizeBytes >= 0
          ? fileSizeBytes
          : undefined,
      columns: parsedColumns,
      rows: cappedRows,
      truncated: parsedRows.length > 50000,
    });

    res.status(201).json(registered);
  });

  router.delete('/datasets/:id', (req, res) => {
    const id = req.params.id;
    const index = store.datasets.findIndex((d) => d.id === id);
    if (index === -1) {
      res.status(404).json({ error: 'Dataset not found.' });
      return;
    }
    const [removed] = store.datasets.splice(index, 1);
    store.datasetPayloads.delete(id);
    store.issues = store.issues.filter((i) => i.datasetId !== id);
    store.detailedIssues = store.detailedIssues.filter((i) => i.datasetId !== id);
    store.diagnoses = store.diagnoses.filter((d) => d.datasetId !== id);
    store.repairs = store.repairs.filter((r) => r.datasetId !== id);
    store.repairSuggestions = store.repairSuggestions.filter((r) => r.datasetId !== id);
    store.modificationHistory = store.modificationHistory.filter((h) => h.datasetId !== id);
    store.auditModifications = store.auditModifications.filter((m) => m.datasetId !== id);
    store.validations = store.validations.filter((v) => v.datasetId !== id);
    store.validationReports = store.validationReports.filter((r) => r.datasetId !== id);
    store.reports = store.reports.filter((r) => r.datasetId !== id);

    store.audits.unshift({
      id: `aud-${Date.now()}`,
      timestamp: formatTimestamp(),
      datasetName: removed.name,
      stage: 'Upload',
      action: 'Removed dataset from active workspace',
      actor: 'Workspace Analyst',
      outcome: 'Completed',
    });

    res.json({ deletedId: id });
  });

  router.post('/datasets/:id/scan', (req, res) => {
    const dataset = store.datasets.find((d) => d.id === req.params.id);
    if (!dataset) {
      res.status(404).json({ error: 'Dataset not found.' });
      return;
    }

    const payload = store.datasetPayloads.get(dataset.id);
    if (!payload) {
      res.status(404).json({ error: 'Dataset rows not available.' });
      return;
    }

    const refreshed = refreshDatasetArtifacts(dataset);
    if (!refreshed) {
      res.status(500).json({ error: 'Unable to profile dataset.' });
      return;
    }

    // Regenerate unapplied repair rules matching newly scanned issues
    const appliedRules = store.repairs.filter(
      (r) => r.datasetId === dataset.id && r.applied
    );
    const freshRules = generateRepairRules(
      dataset.id,
      dataset.columnNames,
      payload.currentRows,
      refreshed.newIssues
    );
    store.repairs = [
      ...freshRules,
      ...appliedRules,
      ...store.repairs.filter((r) => r.datasetId !== dataset.id),
    ];

    store.audits.unshift({
      id: `aud-${Date.now()}`,
      timestamp: formatTimestamp(),
      datasetName: dataset.name,
      stage: 'Detect',
      action: `Completed quality scan (${refreshed.newIssues.length} open issues, quality score ${dataset.qualityScore.toFixed(1)}%)`,
      actor: 'Rule Engine',
      outcome: refreshed.newIssues.length > 0 ? 'Flagged' : 'Completed',
    });

    res.json({
      dataset,
      issues: refreshed.newIssues,
      repairs: freshRules,
    });
  });

  router.post('/datasets/:id/reset', (req, res) => {
    const dataset = store.datasets.find((d) => d.id === req.params.id);
    const payload = store.datasetPayloads.get(req.params.id);
    if (!dataset || !payload) {
      res.status(404).json({ error: 'Dataset not found.' });
      return;
    }

    const priorRowCount = dataset.rows;
    payload.currentRows = payload.rawRows.map((r) => ({ ...r }));
    dataset.repairedCells = 0;
    dataset.previousScore = payload.baselineScore;

    const refreshed = refreshDatasetArtifacts(dataset, { resetBaseline: true });
    if (!refreshed) {
      res.status(500).json({ error: 'Failed to reset dataset state.' });
      return;
    }

    dataset.status = refreshed.newIssues.length > 0 ? 'Needs Review' : 'Validated';

    const freshRules = generateRepairRules(
      dataset.id,
      dataset.columnNames,
      payload.currentRows,
      refreshed.newIssues
    );
    store.repairs = [
      ...freshRules,
      ...store.repairs.filter((r) => r.datasetId !== dataset.id),
    ];

    const nowFormatted = formatTimestamp();
    const restoreEntry: ModificationHistoryEntry = {
      id: nextId('mod-reset'),
      datasetId: dataset.id,
      datasetName: dataset.name,
      timestamp: nowFormatted,
      rowNumber: 0,
      column: 'All Columns',
      issueType: 'Dataset Restore',
      repairMethod: 'Restore Preserved Original Dataset',
      originalValue: `${priorRowCount} current rows`,
      newValue: `${payload.rawRows.length} original rows`,
      reason: 'User restored the working dataset back to the preserved original uploaded records.',
      confidenceLevel: 'High',
      action: 'Restored Original',
      actor: 'Workspace Analyst',
    };
    store.modificationHistory.unshift(restoreEntry);
    store.auditModifications = markDatasetAuditModificationsReverted(
      store.auditModifications,
      dataset.id
    );

    store.audits.unshift({
      id: `aud-${Date.now()}`,
      timestamp: nowFormatted,
      datasetName: dataset.name,
      stage: 'Repair',
      action: 'Restored dataset to preserved original uploaded rows',
      actor: 'Workspace Analyst',
      outcome: 'Completed',
    });

    res.json({
      dataset,
      repairs: freshRules,
      suggestions: refreshed.newRepairSuggestions,
    });
  });

  router.get('/issues', (req, res) => {
    const datasetId =
      typeof req.query.datasetId === 'string' ? req.query.datasetId : undefined;
    const filtered = datasetId
      ? store.issues.filter((item) => item.datasetId === datasetId)
      : store.issues;
    const filteredDetailed = datasetId
      ? store.detailedIssues.filter((item) => item.datasetId === datasetId)
      : store.detailedIssues;
    res.json({ issues: filtered, detailedIssues: filteredDetailed });
  });

  router.get('/diagnosis', (req, res) => {
    const datasetId =
      typeof req.query.datasetId === 'string' ? req.query.datasetId : undefined;
    const filtered = datasetId
      ? store.diagnoses.filter((item) => item.datasetId === datasetId)
      : store.diagnoses;
    res.json({
      diagnoses: filtered,
      geminiConfigured: isGeminiConfigured(),
      model: DEFAULT_GEMINI_MODEL,
    });
  });

  router.post('/datasets/:id/diagnosis', async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      const dataset = store.datasets.find((d) => d.id === req.params.id);
      if (!dataset) {
        res.status(404).json({
          error: `Dataset "${req.params.id}" not found.`,
          code: 'DATASET_NOT_FOUND',
          retryable: false,
        });
        return;
      }

      const detectedIssues = store.detailedIssues.filter(
        (issue) => issue.datasetId === dataset.id
      );
      if (detectedIssues.length === 0) {
        res.status(400).json({
          error: 'No detected quality issues found for this dataset to diagnose.',
          code: 'NO_ISSUES_TO_DIAGNOSE',
          retryable: false,
        });
        return;
      }

      // Pass read-only copies from the Detection Engine; original dataset rows are never modified
      const result = await diagnoseDetectedIssues({
        datasetId: dataset.id,
        datasetName: dataset.name,
        columns: [...dataset.columnNames],
        totalRows: dataset.rows,
        issues: detectedIssues,
      });

      store.diagnoses = [
        ...result.diagnoses,
        ...store.diagnoses.filter(
          (d) => !(d.datasetId === dataset.id && d.source === 'Gemini AI')
        ),
      ];

      store.audits.unshift({
        id: nextId('aud'),
        timestamp: formatTimestamp(),
        datasetName: dataset.name,
        stage: 'Diagnosis',
        action: `Completed Gemini AI diagnosis on ${result.diagnosedCount} detected issues (${result.manualReviewCount} flagged for manual review; original records unchanged)`,
        actor: 'Gemini Diagnosis Engine',
        outcome: 'Completed',
      });

      res.status(200).json(result);
    } catch (err) {
      if (res.headersSent) return;
      if (err instanceof GeminiDiagnosisError) {
        res.status(err.statusCode).json({
          error: err.message,
          code: err.code,
          retryable: err.retryable,
        });
        return;
      }
      const message =
        err instanceof Error
          ? err.message
          : 'Failed to execute Gemini AI diagnosis.';
      console.error('[DataFix API] /datasets/:id/diagnosis error:', message);
      res.status(502).json({
        error: message,
        code: 'GEMINI_UNAVAILABLE',
        retryable: true,
      });
    }
  });

  /**
   * Direct AI diagnosis endpoint accepting structured DetectedIssueRecord[]
   * from the detection engine and returning structured advisory JSON.
   */
  router.post('/diagnosis/analyze', async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      const {
        datasetId,
        datasetName,
        columns,
        totalRows,
        issues,
        model,
      }: {
        datasetId?: string;
        datasetName?: string;
        columns?: string[];
        totalRows?: number;
        issues?: DetectedIssueRecord[];
        model?: string;
      } = req.body ?? {};

      const selectedModel =
        model === 'gemini-3.1-flash-lite' || model === 'gemini-4-hydrogen'
          ? model
          : DEFAULT_GEMINI_MODEL;

      if (!Array.isArray(issues) || issues.length === 0) {
        res.status(400).json({
          error: 'Provide a non-empty "issues" array from the detection engine.',
          code: 'NO_ISSUES_TO_DIAGNOSE',
          retryable: false,
        });
        return;
      }

      const normalizedIssues: DetectedIssueRecord[] = issues.map((raw, idx) => {
        const rec = raw as unknown as Record<string, unknown>;
        return {
          id:
            typeof rec.id === 'string' && rec.id.trim().length > 0
              ? rec.id.trim()
              : `det-direct-${idx + 1}`,
          datasetId: datasetId || 'direct-analysis',
          datasetName: datasetName || 'uploaded_dataset',
          issueType: (typeof rec.issueType === 'string'
            ? rec.issueType
            : typeof rec.category === 'string'
              ? rec.category
              : 'Invalid Formats') as DetectedIssueRecord['issueType'],
          column: typeof rec.column === 'string' ? rec.column : 'unknown',
          rowNumber:
            typeof rec.rowNumber === 'number' && Number.isFinite(rec.rowNumber)
              ? rec.rowNumber
              : idx + 1,
          originalValue:
            rec.originalValue === null || rec.originalValue === undefined
              ? '(empty)'
              : String(rec.originalValue),
          description:
            typeof rec.description === 'string'
              ? rec.description
              : 'Detected data quality issue',
          severity: (rec.severity === 'Critical' ||
          rec.severity === 'Warning' ||
          rec.severity === 'Info'
            ? rec.severity
            : 'Warning') as DetectedIssueRecord['severity'],
          suggestedAction:
            typeof rec.suggestedAction === 'string'
              ? rec.suggestedAction
              : 'Review and correct value',
        };
      });

      const result = await diagnoseDetectedIssues({
        datasetId: datasetId || 'direct-analysis',
        datasetName: datasetName || 'uploaded_dataset',
        columns,
        totalRows,
        issues: normalizedIssues,
        model: selectedModel,
      });
      res.status(200).json(result);
    } catch (err) {
      if (res.headersSent) return;
      if (err instanceof GeminiDiagnosisError) {
        res.status(err.statusCode).json({
          error: err.message,
          code: err.code,
          retryable: err.retryable,
        });
        return;
      }
      const message =
        err instanceof Error
          ? err.message
          : 'Failed to execute Gemini AI diagnosis.';
      console.error('[DataFix API] /diagnosis/analyze error:', message);
      res.status(502).json({
        error: message,
        code: 'GEMINI_UNAVAILABLE',
        retryable: true,
      });
    }
  });

  router.get('/repairs', (req, res) => {
    const datasetId =
      typeof req.query.datasetId === 'string' ? req.query.datasetId : undefined;
    const filtered = datasetId
      ? store.repairs.filter((item) => item.datasetId === datasetId)
      : store.repairs;
    const filteredSuggestions = datasetId
      ? store.repairSuggestions.filter((item) => item.datasetId === datasetId)
      : store.repairSuggestions;
    const filteredHistory = datasetId
      ? store.modificationHistory.filter((item) => item.datasetId === datasetId)
      : store.modificationHistory;
    res.json({
      repairs: filtered,
      suggestions: filteredSuggestions,
      modificationHistory: filteredHistory,
    });
  });

  /**
   * Approval-gated row-level repair execution endpoint:
   * Applies ONLY explicitly approved, non-manual-review suggestions to the working copy.
   * Original uploaded dataset (`payload.rawRows`) is strictly preserved untouched.
   */
  router.post('/datasets/:id/repairs/approve', (req, res) => {
    const dataset = store.datasets.find((d) => d.id === req.params.id);
    const payload = store.datasetPayloads.get(req.params.id);
    if (!dataset || !payload) {
      res.status(404).json({ error: 'Dataset not found.' });
      return;
    }

    const { approvals }: { approvals?: ApproveRepairSelection[] } = req.body ?? {};
    if (!Array.isArray(approvals) || approvals.length === 0) {
      res.status(400).json({
        error: 'Select at least one repair suggestion to approve.',
      });
      return;
    }

    const currentSuggestions = store.repairSuggestions.filter(
      (s) => s.datasetId === dataset.id
    );

    const result = applyApprovedRepairSuggestions({
      datasetId: dataset.id,
      datasetName: dataset.name,
      columns: dataset.columnNames,
      currentRows: payload.currentRows,
      suggestions: currentSuggestions,
      approvals,
      actor: 'Workspace Analyst',
    });

    if (result.appliedCount === 0) {
      res.status(400).json({
        error:
          result.skippedManualReviewCount > 0
            ? 'Selected items require manual review and cannot be auto-applied without source verification.'
            : 'No actionable repair changes matched the approved selection.',
      });
      return;
    }

    // Update working copy ONLY — payload.rawRows remains completely untouched
    payload.currentRows = result.updatedRows;
    payload.repairBatches.push(result.historyEntries);
    dataset.repairedCells += result.cellsModified;

    // Immediately re-analyze and validate approved repairs against preserved original baseline
    const refreshed = refreshDatasetArtifacts(dataset);
    if (!refreshed) {
      res.status(500).json({ error: 'Unable to validate dataset after applying repairs.' });
      return;
    }

    const { validationReport } = refreshed;
    dataset.status =
      refreshed.newIssues.length === 0 && validationReport.failedRepairs === 0
        ? 'Validated'
        : 'In Repair';

    // Record granular modification history, audit modification ledger, & audit activity entry
    store.modificationHistory.unshift(...result.historyEntries);
    const newAuditModifications = recordApprovedModifications({
      historyEntries: result.historyEntries,
      validationReport,
    });
    store.auditModifications.unshift(...newAuditModifications);
    store.auditModifications = syncAuditValidationStatuses(
      store.auditModifications,
      validationReport
    );

    store.audits.unshift({
      id: `aud-${Date.now()}-${dataset.id}`,
      timestamp: formatTimestamp(),
      datasetName: dataset.name,
      stage: 'Repair',
      action: `Approved ${result.appliedCount} repairs — validation engine confirmed ${validationReport.issuesSuccessfullyRepaired} repaired${validationReport.failedRepairs > 0 ? `, ${validationReport.failedRepairs} failed` : ''} (score ${validationReport.originalQualityScore.toFixed(1)}% -> ${validationReport.updatedQualityScore.toFixed(1)}%)`,
      actor: 'Workspace Analyst',
      outcome: validationReport.failedRepairs > 0 ? 'Flagged' : 'Completed',
    });

    res.json({
      dataset,
      appliedCount: result.appliedCount,
      cellsModified: result.cellsModified,
      rowsRemoved: result.rowsRemoved,
      skippedManualReviewCount: result.skippedManualReviewCount,
      historyEntries: result.historyEntries,
      suggestions: refreshed.newRepairSuggestions,
      validationReport,
    });
  });

  router.post('/repairs/apply', (req, res) => {
    const { ruleIds }: { ruleIds?: string[] } = req.body ?? {};
    if (!Array.isArray(ruleIds) || ruleIds.length === 0) {
      res
        .status(400)
        .json({ error: 'Select at least one repair rule to stage or apply.' });
      return;
    }

    const rulesToApply = store.repairs.filter(
      (r) => ruleIds.includes(r.id) && !r.applied
    );
    if (rulesToApply.length === 0) {
      res.status(400).json({
        error: 'Selected repair rules have already been applied.',
      });
      return;
    }

    const rulesByDataset = new Map<string, typeof rulesToApply>();
    for (const rule of rulesToApply) {
      const list = rulesByDataset.get(rule.datasetId) ?? [];
      list.push(rule);
      rulesByDataset.set(rule.datasetId, list);
    }

    let totalCellsModified = 0;
    const appliedIds: string[] = [];
    const nowFormatted = formatTimestamp();

    for (const [datasetId, dsRules] of rulesByDataset.entries()) {
      const dataset = store.datasets.find((d) => d.id === datasetId);
      const payload = store.datasetPayloads.get(datasetId);
      if (!dataset || !payload) continue;

      const { rows: repairedRows, cellsModified } = applyRepairRulesToRows(
        dataset.columnNames,
        payload.currentRows,
        dsRules
      );
      payload.currentRows = repairedRows;
      dataset.repairedCells += cellsModified;
      totalCellsModified += cellsModified;

      for (const rule of dsRules) {
        rule.applied = true;
        rule.selected = true;
        appliedIds.push(rule.id);
      }

      const refreshed = refreshDatasetArtifacts(dataset);
      if (refreshed) {
        dataset.status =
          refreshed.newIssues.length === 0 ? 'Validated' : 'In Repair';
      }

      store.audits.unshift({
        id: `aud-${Date.now()}-${datasetId}`,
        timestamp: nowFormatted,
        datasetName: dataset.name,
        stage: 'Repair',
        action: `Applied ${dsRules.length} repair ${dsRules.length === 1 ? 'rule' : 'rules'} modifying ${cellsModified} cells (score now ${dataset.qualityScore.toFixed(1)}%)`,
        actor: 'Autonomous Repair Engine',
        outcome: 'Completed',
      });
    }

    res.json({
      appliedRuleIds: appliedIds,
      affectedTotal: totalCellsModified,
      repairs: store.repairs,
    });
  });

  router.get('/validations', (req, res) => {
    const datasetId =
      typeof req.query.datasetId === 'string' ? req.query.datasetId : undefined;
    const filtered = datasetId
      ? store.validations.filter((item) => item.datasetId === datasetId)
      : store.validations;
    const filteredReports = datasetId
      ? store.validationReports.filter((item) => item.datasetId === datasetId)
      : store.validationReports;
    res.json({ validations: filtered, reports: filteredReports });
  });

  router.post('/datasets/:id/validate', (req, res) => {
    const dataset = store.datasets.find((d) => d.id === req.params.id);
    if (!dataset) {
      res.status(404).json({ error: 'Dataset not found.' });
      return;
    }

    const refreshed = refreshDatasetArtifacts(dataset);
    if (!refreshed) {
      res.status(404).json({ error: 'Dataset payload not found.' });
      return;
    }

    const { validationReport } = refreshed;
    store.auditModifications = syncAuditValidationStatuses(
      store.auditModifications,
      validationReport
    );
    const allPassed =
      refreshed.newValidations.every((check) => check.passed) &&
      validationReport.failedRepairs === 0;
    dataset.status = allPassed ? 'Validated' : 'Needs Review';

    const nowFormatted = formatTimestamp();
    store.audits.unshift({
      id: `aud-${Date.now()}`,
      timestamp: nowFormatted,
      datasetName: dataset.name,
      stage: 'Validation',
      action: allPassed
        ? `Re-analyzed & passed all validation gates (${validationReport.issuesSuccessfullyRepaired} repairs confirmed, quality score ${validationReport.originalQualityScore.toFixed(1)}% -> ${validationReport.updatedQualityScore.toFixed(1)}%)`
        : `Re-analyzed dataset: ${validationReport.issuesSuccessfullyRepaired} confirmed, ${validationReport.remainingIssues} remaining, ${validationReport.failedRepairs} failed (${validationReport.updatedQualityScore.toFixed(1)}% score)`,
      actor: 'Validation Engine',
      outcome: allPassed ? 'Completed' : 'Flagged',
    });

    if (allPassed) {
      const report: ReportSummary = {
        id: `rpt-${Date.now().toString(36)}`,
        title: `${dataset.name.replace(/\.(csv|xlsx)$/i, '')} Validation Certificate`,
        datasetId: dataset.id,
        datasetName: dataset.name,
        generatedAt: nowFormatted,
        qualityScore: dataset.qualityScore,
        issuesResolved: validationReport.issuesSuccessfullyRepaired,
        openIssues: validationReport.remainingIssues,
        format: 'CSV',
      };
      store.reports.unshift(report);
    }

    res.json({
      dataset,
      allPassed,
      validations: refreshed.newValidations,
      report: validationReport,
    });
  });

  router.get('/datasets/:id/export', (req, res) => {
    const dataset = store.datasets.find((d) => d.id === req.params.id);
    const payload = store.datasetPayloads.get(req.params.id);
    if (!dataset || !payload) {
      res.status(404).json({ error: 'Dataset not found.' });
      return;
    }

    const format = req.query.format === 'xlsx' ? 'xlsx' : 'csv';
    const baseName = dataset.name.replace(/\.(csv|xlsx|xls)$/i, '');

    store.audits.unshift({
      id: `aud-${Date.now()}`,
      timestamp: formatTimestamp(),
      datasetName: dataset.name,
      stage: 'Export',
      action: `Exported ${payload.currentRows.length} cleaned rows (approved modifications only) as ${format.toUpperCase()}`,
      actor: 'Workspace Analyst',
      outcome: 'Completed',
    });

    if (format === 'xlsx') {
      const buffer = buildCleanedExcelExport(
        payload.currentRows,
        dataset.columnNames,
        'CleanedData'
      );
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${baseName}_cleaned.xlsx"`
      );
      res.send(buffer);
      return;
    }

    const csv = buildCleanedCsvExport(payload.currentRows, dataset.columnNames);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${baseName}_cleaned.csv"`
    );
    res.send(csv);
  });

  router.get('/datasets/:id/quality-report', (req, res) => {
    const dataset = store.datasets.find((d) => d.id === req.params.id);
    if (!dataset) {
      res.status(404).json({ error: 'Dataset not found.' });
      return;
    }
    const report = buildDatasetQualityReport(dataset);
    if (!report) {
      res.status(404).json({ error: 'Dataset payload not found.' });
      return;
    }
    res.json({ report });
  });

  router.get('/datasets/:id/export/quality-report', (req, res) => {
    const dataset = store.datasets.find((d) => d.id === req.params.id);
    if (!dataset) {
      res.status(404).json({ error: 'Dataset not found.' });
      return;
    }

    const report = buildDatasetQualityReport(dataset);
    if (!report) {
      res.status(404).json({ error: 'Dataset payload not found.' });
      return;
    }

    const rawFormat =
      typeof req.query.format === 'string'
        ? req.query.format.toLowerCase()
        : 'xlsx';
    const format =
      rawFormat === 'csv' || rawFormat === 'json' ? rawFormat : 'xlsx';
    const baseName = dataset.name.replace(/\.(csv|xlsx|xls)$/i, '');

    store.audits.unshift({
      id: `aud-${Date.now()}`,
      timestamp: formatTimestamp(),
      datasetName: dataset.name,
      stage: 'Export',
      action: `Downloaded Data Quality Report (${report.finalQualityScore.finalScore.toFixed(1)}% final score) as ${format.toUpperCase()}`,
      actor: 'Workspace Analyst',
      outcome: 'Completed',
    });

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${baseName}_quality_report.json"`
      );
      res.send(JSON.stringify(report, null, 2));
      return;
    }

    if (format === 'csv') {
      const csv = buildDataQualityReportCsv(report);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${baseName}_quality_report.csv"`
      );
      res.send(csv);
      return;
    }

    const buffer = buildDataQualityReportExcel(report);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${baseName}_quality_report.xlsx"`
    );
    res.send(buffer);
  });

  router.get('/datasets/:id/export/modifications', (req, res) => {
    const dataset = store.datasets.find((d) => d.id === req.params.id);
    if (!dataset) {
      res.status(404).json({ error: 'Dataset not found.' });
      return;
    }

    const format = req.query.format === 'csv' ? 'csv' : 'xlsx';
    const baseName = dataset.name.replace(/\.(csv|xlsx|xls)$/i, '');
    const datasetMods = store.auditModifications.filter(
      (m) => m.datasetId === dataset.id
    );

    store.audits.unshift({
      id: `aud-${Date.now()}`,
      timestamp: formatTimestamp(),
      datasetName: dataset.name,
      stage: 'Export',
      action: `Downloaded Modification History (${datasetMods.length} ${
        datasetMods.length === 1 ? 'record' : 'records'
      }) as ${format.toUpperCase()}`,
      actor: 'Workspace Analyst',
      outcome: 'Completed',
    });

    if (format === 'csv') {
      const csv = buildModificationHistoryCsv(datasetMods);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${baseName}_modification_history.csv"`
      );
      res.send(csv);
      return;
    }

    const buffer = buildModificationHistoryExcel(datasetMods);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${baseName}_modification_history.xlsx"`
    );
    res.send(buffer);
  });

  router.get('/audit', (req, res) => {
    const datasetId =
      typeof req.query.datasetId === 'string' ? req.query.datasetId : undefined;
    const columnName =
      typeof req.query.column === 'string' ? req.query.column : undefined;
    const repairMethod =
      typeof req.query.repairMethod === 'string'
        ? req.query.repairMethod
        : undefined;
    const rawStatus =
      typeof req.query.validationStatus === 'string'
        ? req.query.validationStatus
        : undefined;
    const validationStatus =
      rawStatus === 'Confirmed' ||
      rawStatus === 'Failed' ||
      rawStatus === 'Pending Validation' ||
      rawStatus === 'Reverted' ||
      rawStatus === 'All'
        ? (rawStatus as 'All' | AuditModificationValidationStatus)
        : undefined;
    const searchQuery =
      typeof req.query.q === 'string' ? req.query.q : undefined;

    const modifications = filterAuditModifications(store.auditModifications, {
      datasetId,
      columnName,
      repairMethod,
      validationStatus,
      searchQuery,
    });

    res.json({
      audits: store.audits,
      modifications,
      totalModifications: store.auditModifications.length,
    });
  });

  router.get('/audit/export', (req, res) => {
    const rawFormat =
      typeof req.query.format === 'string'
        ? req.query.format.toLowerCase()
        : 'csv';
    const format =
      rawFormat === 'json' || rawFormat === 'xlsx' ? rawFormat : 'csv';
    const datasetId =
      typeof req.query.datasetId === 'string' ? req.query.datasetId : undefined;
    const columnName =
      typeof req.query.column === 'string' ? req.query.column : undefined;
    const repairMethod =
      typeof req.query.repairMethod === 'string'
        ? req.query.repairMethod
        : undefined;
    const rawStatus =
      typeof req.query.validationStatus === 'string'
        ? req.query.validationStatus
        : undefined;
    const validationStatus =
      rawStatus === 'Confirmed' ||
      rawStatus === 'Failed' ||
      rawStatus === 'Pending Validation' ||
      rawStatus === 'Reverted' ||
      rawStatus === 'All'
        ? (rawStatus as 'All' | AuditModificationValidationStatus)
        : undefined;
    const searchQuery =
      typeof req.query.q === 'string' ? req.query.q : undefined;

    const modifications = filterAuditModifications(store.auditModifications, {
      datasetId,
      columnName,
      repairMethod,
      validationStatus,
      searchQuery,
    });

    const targetDatasetName =
      datasetId && datasetId !== 'ALL'
        ? store.datasets.find((d) => d.id === datasetId)?.name ?? 'Filtered Workspace'
        : 'All Datasets';

    store.audits.unshift({
      id: `aud-${Date.now()}`,
      timestamp: formatTimestamp(),
      datasetName: targetDatasetName,
      stage: 'Export',
      action: `Downloaded Audit History Report (${modifications.length} modification ${
        modifications.length === 1 ? 'record' : 'records'
      }) as ${format.toUpperCase()}`,
      actor: 'Workspace Analyst',
      outcome: 'Completed',
    });

    if (format === 'json') {
      const payload = buildAuditReportJson(modifications);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="datafix_audit_report.json"'
      );
      res.send(JSON.stringify(payload, null, 2));
      return;
    }

    if (format === 'xlsx') {
      const buffer = buildModificationHistoryExcel(modifications);
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="datafix_modification_history.xlsx"'
      );
      res.send(buffer);
      return;
    }

    const csv = buildModificationHistoryCsv(modifications);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="datafix_audit_report.csv"'
    );
    res.send(csv);
  });

  router.get('/reports', (_req, res) => {
    res.json({ reports: store.reports });
  });

  router.post('/reports/generate', (req, res) => {
    const {
      datasetId,
      format,
    }: { datasetId?: string; format?: 'XLSX' | 'CSV' | 'JSON' } = req.body ?? {};
    const dataset = store.datasets.find((d) => d.id === datasetId);
    if (!dataset) {
      res.status(404).json({ error: 'Select a valid dataset to generate a report.' });
      return;
    }

    const validationReport = store.validationReports.find(
      (r) => r.datasetId === dataset.id
    );
    const resolvedFormat: 'XLSX' | 'CSV' | 'JSON' =
      format === 'JSON' ? 'JSON' : format === 'CSV' ? 'CSV' : 'XLSX';

    const nowFormatted = formatTimestamp();
    const report: ReportSummary = {
      id: `rpt-${Date.now().toString(36)}`,
      title: `${dataset.name.replace(/\.(csv|xlsx)$/i, '')} Data Quality Report`,
      datasetId: dataset.id,
      datasetName: dataset.name,
      generatedAt: nowFormatted,
      qualityScore: dataset.qualityScore,
      issuesResolved:
        validationReport?.issuesSuccessfullyRepaired ?? dataset.repairedCells,
      openIssues: validationReport?.remainingIssues ?? dataset.openIssues,
      format: resolvedFormat,
    };

    store.reports.unshift(report);
    store.audits.unshift({
      id: `aud-${Date.now()}`,
      timestamp: nowFormatted,
      datasetName: dataset.name,
      stage: 'Export',
      action: `Generated ${report.format} data quality report (${report.qualityScore.toFixed(1)}% score)`,
      actor: 'Workspace Analyst',
      outcome: 'Completed',
    });

    res.status(201).json({ report });
  });

  router.use((_req, res) => {
    res.status(404).json({ error: 'API endpoint not found.' });
  });

  // Structured JSON error handler for Multer upload limits and unexpected API failures
  router.use(
    (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (err instanceof MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({
            error: `File exceeds the maximum allowed size (${Math.round(
              DEFAULT_MAX_FILE_BYTES / (1024 * 1024)
            )} MB).`,
            code: 'FILE_TOO_LARGE',
          });
          return;
        }
        res.status(400).json({
          error: err.message || 'Invalid file upload request.',
          code: 'UPLOAD_ERROR',
        });
        return;
      }

      if (err instanceof DatasetProcessingError) {
        res.status(err.statusCode).json({
          error: err.message,
          code: err.code,
        });
        return;
      }

      const message =
        err instanceof Error ? err.message : 'Unexpected server error.';
      res.status(500).json({ error: message, code: 'INTERNAL_SERVER_ERROR' });
    }
  );

  return router;
}
