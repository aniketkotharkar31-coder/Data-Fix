import {
  AlertCircle,
  ArrowRight,
  FileSpreadsheet,
  Loader2,
  Lock,
  Play,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react';
import { useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import { ApiRequestError, datafixApi } from '../../services/api';
import type { DatasetRecord, NavSectionId } from '../../types/datafix';
import {
  PREVIEW_ROW_LIMIT,
  UploadValidationError,
  createSampleCsvUploadFile,
  createSampleXlsxUploadFile,
  formatFileSize,
  parseAndValidateUploadedFile,
  type UploadErrorCode,
  type UploadedDatasetDraft,
} from '../../utils/fileUploadValidation';

interface UploadDatasetViewProps {
  onDatasetCreated: (dataset?: DatasetRecord | null) => Promise<void> | void;
  onNavigate: (section: NavSectionId) => void;
}

interface UploadErrorState {
  title: string;
  message: string;
}

function mapErrorTitle(code?: UploadErrorCode): string {
  switch (code) {
    case 'UNSUPPORTED_TYPE':
      return 'Unsupported File Type';
    case 'EMPTY_FILE':
      return 'Empty File';
    case 'CORRUPTED_FILE':
      return 'Corrupted or Unreadable File';
    case 'FILE_TOO_LARGE':
      return 'File Size Limit Exceeded';
    default:
      return 'Upload Error';
  }
}

export function UploadDatasetView({
  onDatasetCreated,
  onNavigate,
}: UploadDatasetViewProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);

  const [draft, setDraft] = useState<UploadedDatasetDraft | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [uploadError, setUploadError] = useState<UploadErrorState | null>(null);
  const [startingAnalysis, setStartingAnalysis] = useState(false);

  const processFile = async (file: File) => {
    setUploadError(null);
    setIsParsing(true);
    try {
      const parsed = await parseAndValidateUploadedFile(file);
      setDraft(parsed);
      setSelectedFile(file);
    } catch (err) {
      setDraft(null);
      setSelectedFile(null);
      if (err instanceof UploadValidationError) {
        setUploadError({
          title: mapErrorTitle(err.code),
          message: err.message,
        });
      } else {
        setUploadError({
          title: 'Upload Error',
          message:
            err instanceof Error
              ? err.message
              : 'Unable to read the uploaded file. Please verify it is a valid .csv or .xlsx file.',
        });
      }
    } finally {
      setIsParsing(false);
    }
  };

  const handleInputChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      await processFile(file);
    }
    event.target.value = '';
  };

  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current += 1;
    setDragActive(true);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!dragActive) setDragActive(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setDragActive(false);
    }
  };

  const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = 0;
    setDragActive(false);
    const file = event.dataTransfer.files?.[0];
    if (file) {
      await processFile(file);
    }
  };

  const handleRemoveFile = () => {
    setDraft(null);
    setSelectedFile(null);
    setUploadError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleStartAnalysis = async () => {
    if (!draft) return;
    setStartingAnalysis(true);
    setUploadError(null);
    try {
      let createdDataset: DatasetRecord | undefined;

      // Primary path: upload the raw File so Node.js executes readDataset() and analyzeDataset() server-side.
      if (selectedFile) {
        try {
          const uploadResult = await datafixApi.uploadDatasetFile(selectedFile);
          if (uploadResult?.dataset?.id) {
            createdDataset = uploadResult.dataset;
          }
        } catch (uploadErr) {
          // Re-throw explicit 4xx validation errors (e.g. empty, corrupted, unsupported, or oversized file).
          if (
            uploadErr instanceof ApiRequestError &&
            typeof uploadErr.status === 'number' &&
            uploadErr.status >= 400 &&
            uploadErr.status < 500
          ) {
            throw uploadErr;
          }
        }
      }

      // Fallback path: if multipart upload did not return an initialized dataset record, submit the parsed draft via JSON.
      if (!createdDataset?.id) {
        const fallbackResult = await datafixApi.createDataset({
          name: draft.name,
          fileType: draft.fileType,
          fileSizeBytes: draft.fileSizeBytes,
          columns: [...draft.columns],
          rows: draft.originalRows.map((row) => ({ ...row })),
        });
        createdDataset = fallbackResult?.dataset;
      }

      if (!createdDataset?.id) {
        throw new Error(
          'Unable to initialize the dataset for analysis because no dataset ID was returned by the server.'
        );
      }

      await onDatasetCreated(createdDataset);
      onNavigate('detect');
    } catch (err) {
      setUploadError({
        title: 'Analysis Failed to Start',
        message:
          err instanceof Error
            ? err.message
            : 'Unable to submit the uploaded dataset for analysis.',
      });
    } finally {
      setStartingAnalysis(false);
    }
  };

  const handleLoadSampleCsv = async () => {
    try {
      const sampleFile = createSampleCsvUploadFile();
      await processFile(sampleFile);
    } catch (err) {
      setDraft(null);
      setSelectedFile(null);
      setUploadError({
        title: 'Upload Error',
        message:
          err instanceof Error
            ? err.message
            : 'Unable to initialize the sample CSV dataset.',
      });
    }
  };

  const handleLoadSampleXlsx = async () => {
    try {
      const sampleFile = createSampleXlsxUploadFile();
      await processFile(sampleFile);
    } catch (err) {
      setDraft(null);
      setSelectedFile(null);
      setUploadError({
        title: 'Upload Error',
        message:
          err instanceof Error
            ? err.message
            : 'Unable to initialize the sample Excel dataset.',
      });
    }
  };

  const previewCount = draft
    ? Math.min(PREVIEW_ROW_LIMIT, draft.totalRows)
    : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[#0B192C]">
            Upload Dataset
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Upload a CSV (.csv) or Excel (.xlsx) file to inspect its exact structure and preview the first 10 rows before starting data quality analysis.
          </p>
        </div>
        <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500 whitespace-nowrap">
          <Lock className="h-3.5 w-3.5 text-[#C4962C]" aria-hidden="true" />
          <span>Original dataset preserved unchanged</span>
        </div>
      </div>

      {/* Drag-and-Drop Upload Area */}
      <section aria-label="Dataset file uploader">
        <div
          data-testid="upload-dropzone"
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`rounded-lg border-2 border-dashed bg-white px-6 py-9 text-center transition-colors ${
            dragActive
              ? 'border-[#0284C7] bg-[#EBF5FC]/60'
              : 'border-slate-300 hover:border-[#0284C7]/70'
          }`}
        >
          <input
            ref={fileInputRef}
            id="dataset-file-input"
            type="file"
            accept=".csv,.xlsx"
            onChange={handleInputChange}
            className="sr-only"
          />

          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg bg-[#EBF5FC] text-[#0284C7]">
            <UploadCloud className="h-6 w-6" aria-hidden="true" />
          </div>

          <h2 className="mt-4 text-base font-semibold text-[#0B192C]">
            {dragActive
              ? 'Release to upload dataset'
              : 'Drag and drop your CSV or Excel file here'}
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Supported formats: <span className="font-mono text-xs text-[#0B192C]">.csv</span> and{' '}
            <span className="font-mono text-xs text-[#0B192C]">.xlsx</span> · Maximum file size 25 MB
          </p>

          <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              disabled={isParsing || startingAnalysis}
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-2 rounded-md bg-[#0B192C] px-4 py-2 text-sm font-medium text-white hover:bg-[#163155] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0284C7] focus-visible:ring-offset-2 whitespace-nowrap"
            >
              {isParsing && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              <span>{isParsing ? 'Reading File...' : draft ? 'Choose Another File' : 'Browse Files'}</span>
            </button>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-slate-500">
            <span>Need a test file?</span>
            <button
              type="button"
              disabled={isParsing || startingAnalysis}
              onClick={handleLoadSampleCsv}
              className="font-medium text-[#0284C7] hover:text-[#0B192C] underline underline-offset-2 disabled:opacity-50"
            >
              Use sample CSV
            </button>
            <span aria-hidden="true" className="text-slate-300">
              ·
            </span>
            <button
              type="button"
              disabled={isParsing || startingAnalysis}
              onClick={handleLoadSampleXlsx}
              className="font-medium text-[#0284C7] hover:text-[#0B192C] underline underline-offset-2 disabled:opacity-50"
            >
              Use sample Excel (.xlsx)
            </button>
          </div>
        </div>
      </section>

      {/* Loading Indicator for File Parsing / Backend Analysis */}
      {(isParsing || startingAnalysis) && (
        <div
          role="status"
          aria-live="polite"
          aria-busy="true"
          data-testid="upload-loading-indicator"
          className="flex items-center gap-3 rounded-lg border border-[#0284C7]/30 bg-[#EBF5FC] px-4 py-3 text-sm text-[#0B192C]"
        >
          <Loader2 className="h-4 w-4 animate-spin text-[#0284C7] shrink-0" aria-hidden="true" />
          <span>
            {isParsing
              ? 'Validating file format and reading rows...'
              : 'Uploading dataset to backend engine, running quality detection, and generating repair suggestions...'}
          </span>
        </div>
      )}

      {/* Validation & Parsing Error Alert */}
      {uploadError && (
        <div
          role="alert"
          data-testid="upload-error-banner"
          className="flex items-start justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3.5 text-sm text-red-900"
        >
          <div className="flex items-start gap-2.5 min-w-0">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
            <div className="min-w-0">
              <p className="font-semibold text-red-900">{uploadError.title}</p>
              <p className="mt-0.5 text-xs sm:text-sm text-red-800">{uploadError.message}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setUploadError(null)}
            aria-label="Dismiss error message"
            className="rounded p-1 text-red-700 hover:bg-red-100 shrink-0"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Uploaded File Metadata + Actions + First 10 Rows Preview */}
      {draft ? (
        <div className="space-y-6" data-testid="uploaded-file-summary">
          {/* Action Header Card */}
          <section
            aria-label="Uploaded file details"
            className="rounded-lg border border-slate-200 bg-white overflow-hidden"
          >
            <div className="flex flex-col gap-4 border-b border-slate-200 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex items-start gap-3 min-w-0">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-[#EBF5FC] text-[#0284C7]">
                  <FileSpreadsheet className="h-5 w-5" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <h2
                    className="text-base font-semibold text-[#0B192C] break-all"
                    data-testid="uploaded-filename"
                  >
                    {draft.name}
                  </h2>
                  <p className="mt-0.5 text-xs text-slate-500">
                    <span>{draft.fileType} file ready for analysis</span>
                    <span aria-hidden="true" className="mx-1.5 text-slate-300">
                      ·
                    </span>
                    <span>Original uploaded values kept unmodified</span>
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                <button
                  type="button"
                  disabled={startingAnalysis}
                  onClick={handleRemoveFile}
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:border-red-300 hover:bg-red-50 hover:text-red-700 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0284C7] whitespace-nowrap"
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                  <span>Remove File</span>
                </button>
                <button
                  type="button"
                  disabled={startingAnalysis}
                  onClick={handleStartAnalysis}
                  data-testid="start-analysis-btn"
                  className="inline-flex items-center gap-2 rounded-md bg-[#0284C7] px-4 py-2 text-sm font-semibold text-white hover:bg-[#0369A1] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0284C7] focus-visible:ring-offset-2 whitespace-nowrap"
                >
                  {startingAnalysis ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Play className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
                  )}
                  <span>{startingAnalysis ? 'Analyzing Dataset...' : 'Start Analysis'}</span>
                  {!startingAnalysis && <ArrowRight className="h-4 w-4" aria-hidden="true" />}
                </button>
              </div>
            </div>

            {/* 4 Actual Uploaded File Statistics */}
            <div className="grid grid-cols-1 divide-y divide-slate-200 sm:grid-cols-2 sm:divide-y-0 sm:divide-x lg:grid-cols-4">
              <div className="p-4 sm:p-5 min-w-0">
                <p className="text-xs font-medium text-slate-500">Uploaded Filename</p>
                <p
                  className="mt-1.5 font-mono text-sm font-semibold text-[#0B192C] truncate"
                  title={draft.name}
                >
                  {draft.name}
                </p>
                <p className="mt-1 text-xs text-slate-500">{draft.fileType} Format</p>
              </div>

              <div className="p-4 sm:p-5 min-w-0 border-t border-slate-200 sm:border-t-0">
                <p className="text-xs font-medium text-slate-500">File Size</p>
                <p
                  className="mt-1.5 font-mono text-2xl font-semibold tabular-nums text-[#0B192C]"
                  data-testid="uploaded-filesize"
                >
                  {formatFileSize(draft.fileSizeBytes)}
                </p>
                <p className="mt-1 font-mono text-xs tabular-nums text-slate-500">
                  {draft.fileSizeBytes.toLocaleString()} bytes
                </p>
              </div>

              <div className="p-4 sm:p-5 min-w-0 border-t border-slate-200 lg:border-t-0">
                <p className="text-xs font-medium text-slate-500">Total Rows</p>
                <p
                  className="mt-1.5 font-mono text-2xl font-semibold tabular-nums text-[#0B192C]"
                  data-testid="uploaded-total-rows"
                >
                  {draft.totalRows.toLocaleString()}
                </p>
                <p className="mt-1 text-xs text-slate-500">Parsed data records</p>
              </div>

              <div className="p-4 sm:p-5 min-w-0 border-t border-slate-200 lg:border-t-0">
                <p className="text-xs font-medium text-slate-500">Total Columns</p>
                <p
                  className="mt-1.5 font-mono text-2xl font-semibold tabular-nums text-[#0284C7]"
                  data-testid="uploaded-total-columns"
                >
                  {draft.totalColumns.toLocaleString()}
                </p>
                <p className="mt-1 text-xs text-slate-500">Detected schema fields</p>
              </div>
            </div>
          </section>

          {/* First 10 Rows Data Preview */}
          <section
            aria-label="Dataset preview"
            className="rounded-lg border border-slate-200 bg-white overflow-hidden"
          >
            <div className="flex flex-col gap-1 border-b border-slate-200 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="text-base font-semibold text-[#0B192C]">
                  Data Preview (First 10 Rows)
                </h3>
                <p className="text-xs text-slate-500">
                  {draft.totalRows <= PREVIEW_ROW_LIMIT
                    ? `Showing all ${draft.totalRows} uploaded ${draft.totalRows === 1 ? 'row' : 'rows'}`
                    : `Showing first ${previewCount} of ${draft.totalRows.toLocaleString()} uploaded rows`}
                  <span aria-hidden="true" className="mx-1.5 text-slate-300">
                    ·
                  </span>
                  <span>Raw source values displayed without modification</span>
                </p>
              </div>
              <span className="font-mono text-xs text-[#A17816] tabular-nums whitespace-nowrap">
                {draft.totalColumns} columns · {previewCount} preview rows
              </span>
            </div>

            <div className="w-full overflow-x-auto">
              <table
                className="w-full min-w-[600px] border-collapse text-left text-xs"
                data-testid="upload-preview-table"
              >
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/80 text-slate-600">
                    <th className="w-12 py-2.5 pl-5 pr-3 font-mono font-medium text-slate-400">
                      #
                    </th>
                    {draft.columns.map((col) => (
                      <th
                        key={col}
                        className="px-3.5 py-2.5 font-mono font-semibold text-[#0B192C] whitespace-nowrap"
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {draft.previewRows.map((row, rowIndex) => (
                    <tr
                      key={rowIndex}
                      className="h-10 transition-colors hover:bg-[#EBF5FC]/35"
                    >
                      <td className="py-2 pl-5 pr-3 font-mono tabular-nums text-slate-400">
                        {rowIndex + 1}
                      </td>
                      {draft.columns.map((col) => {
                        const cell = row[col];
                        const isEmpty = cell === null || cell === undefined || cell === '';
                        return (
                          <td
                            key={col}
                            className={`px-3.5 py-2 font-mono tabular-nums whitespace-nowrap ${
                              isEmpty ? 'text-amber-700 italic' : 'text-slate-700'
                            }`}
                          >
                            {isEmpty ? '(empty)' : String(cell)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      ) : (
        /* Pre-upload Guidance Panel (strictly factual, zero fake statistics) */
        <section
          aria-label="Upload requirements and integrity guarantees"
          className="grid grid-cols-1 gap-4 md:grid-cols-3"
        >
          <div className="rounded-lg border border-slate-200 bg-white p-5">
            <p className="font-mono text-xs font-semibold text-[#0284C7]">01 · FORMATS</p>
            <h3 className="mt-1.5 text-sm font-semibold text-[#0B192C]">
              CSV & Excel (.xlsx) Only
            </h3>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
              CSV files are decoded with PapaParse and Excel workbooks (.xlsx) are read via SheetJS. Unsupported file types are rejected automatically.
            </p>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-5">
            <p className="font-mono text-xs font-semibold text-[#0284C7]">02 · VALIDATION</p>
            <h3 className="mt-1.5 text-sm font-semibold text-[#0B192C]">
              Empty & Corruption Checks
            </h3>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
              Every uploaded file is verified for non-zero size, valid structure, readable column headers, and data rows before previewing.
            </p>
          </div>

          <div className="rounded-lg border border-[#D9B352]/50 bg-white p-5">
            <p className="font-mono text-xs font-semibold text-[#A17816]">03 · INTEGRITY</p>
            <h3 className="mt-1.5 text-sm font-semibold text-[#0B192C]">
              Original Dataset Unchanged
            </h3>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
              Your uploaded source rows are preserved in an immutable snapshot. Click Start Analysis whenever you are ready to run quality detection.
            </p>
          </div>
        </section>
      )}
    </div>
  );
}
