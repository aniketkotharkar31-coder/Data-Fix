import type { NavSectionId } from '../types/datafix';

export interface NavItemConfig {
  id: NavSectionId;
  label: string;
  stepNumber: string;
  description: string;
}

export const NAVIGATION_ITEMS: NavItemConfig[] = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    stepNumber: '01',
    description: 'Workspace quality index, anomaly trends, and active datasets',
  },
  {
    id: 'upload',
    label: 'Upload Dataset',
    stepNumber: '02',
    description: 'Ingest CSV or Excel files with schema preview via PapaParse & SheetJS',
  },
  {
    id: 'detect',
    label: 'Detect Issues',
    stepNumber: '03',
    description: 'Inspect completeness, schema, uniqueness, and range violations',
  },
  {
    id: 'diagnosis',
    label: 'AI Diagnosis',
    stepNumber: '04',
    description: 'Root-cause error analysis and recommendations powered by Gemini',
  },
  {
    id: 'repair',
    label: 'Repair Data',
    stepNumber: '05',
    description: 'Review deterministic transformation plans and apply staged fixes',
  },
  {
    id: 'validation',
    label: 'Validation',
    stepNumber: '06',
    description: 'Verify post-repair quality assertions and export cleaned datasets',
  },
  {
    id: 'audit',
    label: 'Audit History',
    stepNumber: '07',
    description: 'Chronological ledger of ingestion, scans, repairs, and exports',
  },
  {
    id: 'reports',
    label: 'Reports',
    stepNumber: '08',
    description: 'Executive quality comparisons and exportable compliance summaries',
  },
];
