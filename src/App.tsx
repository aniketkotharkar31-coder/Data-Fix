import { useCallback, useEffect, useState } from 'react';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { Sidebar } from './components/layout/Sidebar';
import { TopHeader } from './components/layout/TopHeader';
import { WorkflowPipelineBar } from './components/layout/WorkflowPipelineBar';
import { AiDiagnosisView } from './components/views/AiDiagnosisView';
import { AuditHistoryView } from './components/views/AuditHistoryView';
import { DashboardView } from './components/views/DashboardView';
import { DetectIssuesView } from './components/views/DetectIssuesView';
import { RepairDataView } from './components/views/RepairDataView';
import { ReportsView } from './components/views/ReportsView';
import { UploadDatasetView } from './components/views/UploadDatasetView';
import { ValidationView } from './components/views/ValidationView';
import { datafixApi } from './services/api';
import type {
  AuditEntry,
  AuditModificationRecord,
  DashboardSummary,
  DatasetRecord,
  DetectedIssueRecord,
  DiagnosisInsight,
  ModificationHistoryEntry,
  NavSectionId,
  QualityIssue,
  RepairSuggestion,
  ReportSummary,
  ValidationCheck,
  ValidationComparisonReport,
} from './types/datafix';

export default function App() {
  const [activeSection, setActiveSection] = useState<NavSectionId>('dashboard');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [datasets, setDatasets] = useState<DatasetRecord[]>([]);
  const [issues, setIssues] = useState<QualityIssue[]>([]);
  const [detailedIssues, setDetailedIssues] = useState<DetectedIssueRecord[]>([]);
  const [diagnoses, setDiagnoses] = useState<DiagnosisInsight[]>([]);
  const [repairSuggestions, setRepairSuggestions] = useState<RepairSuggestion[]>([]);
  const [modificationHistory, setModificationHistory] = useState<ModificationHistoryEntry[]>([]);
  const [validations, setValidations] = useState<ValidationCheck[]>([]);
  const [validationReports, setValidationReports] = useState<ValidationComparisonReport[]>([]);
  const [audits, setAudits] = useState<AuditEntry[]>([]);
  const [auditModifications, setAuditModifications] = useState<AuditModificationRecord[]>([]);
  const [reports, setReports] = useState<ReportSummary[]>([]);

  const [selectedDatasetId, setSelectedDatasetId] = useState<string>('ALL');
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const fetchWorkspaceData = useCallback(async (silent = false): Promise<DatasetRecord[]> => {
    if (silent) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setLoadError(null);
    try {
      const [
        dashboardRes,
        datasetsRes,
        issuesRes,
        diagnosisRes,
        repairsRes,
        validationsRes,
        auditRes,
        reportsRes,
      ] = await Promise.all([
        datafixApi.getDashboard(),
        datafixApi.getDatasets(),
        datafixApi.getIssues(),
        datafixApi.getDiagnosis(),
        datafixApi.getRepairs(),
        datafixApi.getValidations(),
        datafixApi.getAuditHistory(),
        datafixApi.getReports(),
      ]);

      const nextDatasets = Array.isArray(datasetsRes?.datasets)
        ? datasetsRes.datasets
        : [];
      setSummary(dashboardRes);
      setDatasets(nextDatasets);
      setIssues(Array.isArray(issuesRes?.issues) ? issuesRes.issues : []);
      setDetailedIssues(Array.isArray(issuesRes?.detailedIssues) ? issuesRes.detailedIssues : []);
      setDiagnoses(Array.isArray(diagnosisRes?.diagnoses) ? diagnosisRes.diagnoses : []);
      setRepairSuggestions(Array.isArray(repairsRes?.suggestions) ? repairsRes.suggestions : []);
      setModificationHistory(
        Array.isArray(repairsRes?.modificationHistory) ? repairsRes.modificationHistory : []
      );
      setValidations(Array.isArray(validationsRes?.validations) ? validationsRes.validations : []);
      setValidationReports(Array.isArray(validationsRes?.reports) ? validationsRes.reports : []);
      setAudits(Array.isArray(auditRes?.audits) ? auditRes.audits : []);
      setAuditModifications(Array.isArray(auditRes?.modifications) ? auditRes.modifications : []);
      setReports(Array.isArray(reportsRes?.reports) ? reportsRes.reports : []);
      return nextDatasets;
    } catch (err) {
      setLoadError(
        err instanceof Error
          ? err.message
          : 'Failed to load workspace data from the DataFix backend.'
      );
      return [];
    } finally {
      if (silent) {
        setRefreshing(false);
      } else {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void fetchWorkspaceData();
  }, [fetchWorkspaceData]);

  const handleInspectDataset = (datasetId: string, destination: NavSectionId) => {
    setSelectedDatasetId(datasetId);
    setActiveSection(destination);
  };

  const handleDatasetCreated = async (dataset?: DatasetRecord | null) => {
    if (dataset?.id) {
      setSelectedDatasetId(dataset.id);
    }
    const refreshedDatasets = await fetchWorkspaceData(true);
    if (!dataset?.id && refreshedDatasets.length > 0) {
      const matched = dataset?.name
        ? refreshedDatasets.find((d) => d?.name === dataset.name)
        : undefined;
      const fallbackId = matched?.id ?? refreshedDatasets[0]?.id;
      if (fallbackId) {
        setSelectedDatasetId(fallbackId);
      }
    }
  };

  const handleDiagnosesUpdated = async (newFindings: DiagnosisInsight[]) => {
    setDiagnoses((prev) => {
      const datasetId = newFindings[0]?.datasetId;
      const retained = prev.filter(
        (item) => !(item.datasetId === datasetId && item.source === 'Gemini AI')
      );
      return [...newFindings, ...retained];
    });
    await fetchWorkspaceData(true);
  };

  const handleWorkspaceMutated = async (): Promise<void> => {
    await fetchWorkspaceData(true);
  };

  const activeDataset =
    (selectedDatasetId && selectedDatasetId !== 'ALL'
      ? datasets.find((d) => d.id === selectedDatasetId)
      : undefined) ??
    datasets[0] ??
    null;

  return (
    <div className="min-h-screen bg-[#F6F8FB] text-[#0F1E36]">
      <Sidebar
        activeSection={activeSection}
        onSelectSection={setActiveSection}
        mobileOpen={mobileMenuOpen}
        onCloseMobile={() => setMobileMenuOpen(false)}
        datasetCount={datasets.length}
      />

      <div className="lg:pl-64 flex min-h-screen flex-col min-w-0 overflow-x-clip">
        <TopHeader
          activeSection={activeSection}
          onOpenMobileMenu={() => setMobileMenuOpen(true)}
          onNavigateUpload={() => setActiveSection('upload')}
          activeDatasetName={activeDataset?.name}
        />

        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8 max-w-[1440px] w-full min-w-0 mx-auto">
          {refreshing && (
            <div
              role="status"
              aria-live="polite"
              data-testid="workspace-refresh-indicator"
              className="mb-4 flex items-center gap-2 rounded-md border border-[#0284C7]/25 bg-[#EBF5FC]/70 px-3.5 py-2 text-xs font-medium text-[#0B192C]"
            >
              <span
                aria-hidden="true"
                className="h-3 w-3 rounded-full border-2 border-[#0284C7] border-t-transparent animate-spin"
              />
              <span>Synchronizing dataset state across DataFix modules...</span>
            </div>
          )}

          {loadError && (
            <div
              role="alert"
              className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
            >
              <span>{loadError}</span>
              <button
                type="button"
                onClick={() => void fetchWorkspaceData()}
                className="rounded border border-red-300 bg-white px-3 py-1 text-xs font-medium text-red-800 hover:bg-red-50"
              >
                Retry Connection
              </button>
            </div>
          )}

          <WorkflowPipelineBar
            activeSection={activeSection}
            activeDataset={activeDataset}
            detailedIssues={detailedIssues}
            diagnoses={diagnoses}
            repairSuggestions={repairSuggestions}
            validationReports={validationReports}
            auditModifications={auditModifications}
            onNavigate={(dest) => {
              if (activeDataset?.id && selectedDatasetId === 'ALL' && dest !== 'detect' && dest !== 'audit') {
                setSelectedDatasetId(activeDataset.id);
              }
              setActiveSection(dest);
            }}
          />

          <ErrorBoundary key={activeSection}>
            {activeSection === 'dashboard' && (
              <DashboardView
                summary={summary}
                datasets={datasets}
                issues={issues}
                audits={audits}
                diagnoses={diagnoses}
                loading={loading}
                onInspectDataset={handleInspectDataset}
                onNavigate={setActiveSection}
              />
            )}

            {activeSection === 'upload' && (
              <UploadDatasetView
                onDatasetCreated={handleDatasetCreated}
                onNavigate={setActiveSection}
              />
            )}

            {activeSection === 'detect' && (
              <DetectIssuesView
                datasets={datasets}
                selectedDatasetId={selectedDatasetId}
                onSelectDataset={setSelectedDatasetId}
                issues={issues}
                detailedIssues={detailedIssues}
                onScanComplete={handleWorkspaceMutated}
                onNavigate={setActiveSection}
              />
            )}

            {activeSection === 'diagnosis' && (
              <AiDiagnosisView
                datasets={datasets}
                selectedDatasetId={selectedDatasetId}
                onSelectDataset={setSelectedDatasetId}
                detailedIssues={detailedIssues}
                diagnoses={diagnoses}
                onDiagnosesUpdated={handleDiagnosesUpdated}
                onNavigate={setActiveSection}
              />
            )}

            {activeSection === 'repair' && (
              <RepairDataView
                datasets={datasets}
                selectedDatasetId={selectedDatasetId}
                onSelectDataset={setSelectedDatasetId}
                suggestions={repairSuggestions}
                modificationHistory={modificationHistory}
                onRepairsUpdated={handleWorkspaceMutated}
                onNavigate={setActiveSection}
              />
            )}

            {activeSection === 'validation' && (
              <ValidationView
                datasets={datasets}
                selectedDatasetId={selectedDatasetId}
                onSelectDataset={setSelectedDatasetId}
                validations={validations}
                validationReports={validationReports}
                onValidationComplete={handleWorkspaceMutated}
                onNavigate={setActiveSection}
              />
            )}

            {activeSection === 'audit' && (
              <AuditHistoryView
                datasets={datasets}
                selectedDatasetId={selectedDatasetId}
                onSelectDataset={setSelectedDatasetId}
                audits={audits}
                modifications={auditModifications}
                onNavigate={setActiveSection}
                onAuditExported={handleWorkspaceMutated}
              />
            )}

            {activeSection === 'reports' && (
              <ReportsView
                datasets={datasets}
                selectedDatasetId={selectedDatasetId}
                onSelectDataset={setSelectedDatasetId}
                reports={reports}
                validationReports={validationReports}
                auditModifications={auditModifications}
                onReportGenerated={handleWorkspaceMutated}
                onNavigate={setActiveSection}
              />
            )}
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
