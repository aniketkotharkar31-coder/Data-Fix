import { CheckCircle2, CircleDot } from 'lucide-react';
import type {
  AuditModificationRecord,
  DatasetRecord,
  DetectedIssueRecord,
  DiagnosisInsight,
  NavSectionId,
  RepairSuggestion,
  ValidationComparisonReport,
} from '../../types/datafix';

interface WorkflowPipelineBarProps {
  activeSection: NavSectionId;
  activeDataset: DatasetRecord | null;
  detailedIssues: DetectedIssueRecord[];
  diagnoses: DiagnosisInsight[];
  repairSuggestions: RepairSuggestion[];
  validationReports: ValidationComparisonReport[];
  auditModifications: AuditModificationRecord[];
  onNavigate: (section: NavSectionId) => void;
}

interface PipelineStep {
  id: NavSectionId;
  label: string;
  detail: string;
  completed: boolean;
}

export function WorkflowPipelineBar({
  activeSection,
  activeDataset,
  detailedIssues,
  diagnoses,
  repairSuggestions,
  validationReports,
  auditModifications,
  onNavigate,
}: WorkflowPipelineBarProps) {
  const datasetId = activeDataset?.id;
  if (!datasetId || activeSection === 'dashboard') {
    return null;
  }
  const issueCount = detailedIssues.filter((i) => i.datasetId === datasetId).length;
  const aiDiagnosedCount = diagnoses.filter(
    (d) => d.datasetId === datasetId && d.source === 'Gemini AI'
  ).length;
  const actionableSuggestionCount = repairSuggestions.filter(
    (s) => s.datasetId === datasetId && !s.manualReviewOnly
  ).length;
  const datasetModCount = auditModifications.filter(
    (m) => m.datasetId === datasetId && m.validationStatus !== 'Reverted'
  ).length;
  const validationReport = validationReports.find((r) => r.datasetId === datasetId);

  const steps: PipelineStep[] = [
    {
      id: 'upload',
      label: 'Upload',
      detail: `${activeDataset.rows.toLocaleString()} rows`,
      completed: true,
    },
    {
      id: 'detect',
      label: 'Detect',
      detail: issueCount === 0 ? '0 open' : `${issueCount} open`,
      completed: true,
    },
    {
      id: 'diagnosis',
      label: 'AI Diagnosis',
      detail:
        aiDiagnosedCount > 0
          ? `${aiDiagnosedCount} diagnosed`
          : issueCount === 0
            ? 'Clean'
            : 'Ready',
      completed: aiDiagnosedCount > 0 || issueCount === 0,
    },
    {
      id: 'repair',
      label: 'Repair',
      detail:
        datasetModCount > 0
          ? `${datasetModCount} applied`
          : actionableSuggestionCount > 0
            ? `${actionableSuggestionCount} suggested`
            : 'Clean',
      completed: datasetModCount > 0 || actionableSuggestionCount === 0,
    },
    {
      id: 'validation',
      label: 'Validate',
      detail: validationReport
        ? `${validationReport.updatedQualityScore.toFixed(1)}%`
        : `${activeDataset.qualityScore.toFixed(1)}%`,
      completed: Boolean(
        validationReport &&
          (validationReport.reanalyzedAfterRepairs ||
            validationReport.totalIssuesDetected === 0)
      ),
    },
    {
      id: 'audit',
      label: 'Audit',
      detail: `${datasetModCount} logged`,
      completed: datasetModCount > 0,
    },
    {
      id: 'reports',
      label: 'Export',
      detail: 'CSV & XLSX',
      completed: Boolean(
        validationReport &&
          (validationReport.reanalyzedAfterRepairs ||
            validationReport.totalIssuesDetected === 0)
      ),
    },
  ];

  return (
    <nav
      aria-label="Dataset workflow pipeline"
      data-testid="workflow-pipeline-bar"
      className="mb-6 rounded-lg border border-slate-200 bg-white px-4 py-3"
    >
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-semibold text-slate-500 whitespace-nowrap">
              Active Dataset:
            </span>
            <span
              data-testid="pipeline-active-dataset-name"
              className="font-mono font-semibold text-[#0B192C] truncate"
              title={activeDataset.name}
            >
              {activeDataset.name}
            </span>
            <span aria-hidden="true" className="text-slate-300">
              ·
            </span>
            <span className="font-mono tabular-nums text-slate-500 whitespace-nowrap">
              {activeDataset.fileType}
            </span>
            <span aria-hidden="true" className="text-slate-300">
              ·
            </span>
            <span className="font-mono tabular-nums font-semibold text-[#0284C7] whitespace-nowrap">
              {activeDataset.qualityScore.toFixed(1)}%
            </span>
          </div>
          <span className="hidden sm:inline font-mono text-[11px] tabular-nums text-slate-500 whitespace-nowrap">
            {activeDataset.rows.toLocaleString()} rows × {activeDataset.columns} cols
          </span>
        </div>

        <ol className="flex items-stretch gap-1.5 overflow-x-auto pb-0.5 lg:grid lg:grid-cols-7 lg:overflow-visible lg:pb-0">
          {steps.map((step) => {
            const isCurrent = activeSection === step.id;
            return (
              <li key={step.id} className="shrink-0 lg:min-w-0">
                <button
                  type="button"
                  onClick={() => onNavigate(step.id)}
                  data-testid={`pipeline-step-${step.id}`}
                  aria-current={isCurrent ? 'step' : undefined}
                  className={`w-full h-full flex flex-col items-start justify-center gap-0.5 rounded-md border px-2.5 py-1.5 text-left transition-colors whitespace-nowrap ${
                    isCurrent
                      ? 'border-[#0B192C] bg-[#0B192C] text-white'
                      : step.completed
                        ? 'border-slate-200 bg-slate-50/90 text-[#0B192C] hover:border-[#0284C7]/40 hover:bg-[#EBF5FC]'
                        : 'border-slate-200/80 bg-white text-slate-700 hover:bg-slate-50 hover:text-[#0B192C]'
                  }`}
                >
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold leading-tight">
                    {step.completed ? (
                      <CheckCircle2
                        aria-hidden="true"
                        className={`h-3.5 w-3.5 shrink-0 ${
                          isCurrent ? 'text-[#D9B352]' : 'text-emerald-600'
                        }`}
                      />
                    ) : (
                      <CircleDot
                        aria-hidden="true"
                        className={`h-3.5 w-3.5 shrink-0 ${
                          isCurrent ? 'text-[#38BDF8]' : 'text-slate-400'
                        }`}
                      />
                    )}
                    <span>{step.label}</span>
                  </span>
                  <span
                    className={`pl-5 font-mono text-[11px] tabular-nums leading-tight ${
                      isCurrent ? 'text-slate-300' : 'text-slate-500'
                    }`}
                  >
                    {step.detail}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </nav>
  );
}
