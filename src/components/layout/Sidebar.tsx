import {
  Activity,
  BarChart3,
  CheckCircle2,
  FileSearch,
  History,
  LayoutDashboard,
  Sparkles,
  Upload,
  Wrench,
  X,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { NAVIGATION_ITEMS } from '../../config/navigation';
import type { NavSectionId } from '../../types/datafix';

interface SidebarProps {
  activeSection: NavSectionId;
  onSelectSection: (section: NavSectionId) => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  datasetCount: number;
}

const SECTION_ICONS: Record<NavSectionId, ComponentType<{ className?: string }>> = {
  dashboard: LayoutDashboard,
  upload: Upload,
  detect: FileSearch,
  diagnosis: Sparkles,
  repair: Wrench,
  validation: CheckCircle2,
  audit: History,
  reports: BarChart3,
};

export function Sidebar({
  activeSection,
  onSelectSection,
  mobileOpen,
  onCloseMobile,
  datasetCount,
}: SidebarProps) {
  const handleNavClick = (id: NavSectionId) => {
    onSelectSection(id);
    onCloseMobile();
  };

  const sidebarContent = (
    <div className="flex h-full flex-col bg-[#0B192C] text-slate-200 select-none">
      {/* Brand mark */}
      <div className="flex h-16 items-center justify-between px-5 border-b border-white/10">
        <button
          type="button"
          onClick={() => handleNavClick('dashboard')}
          className="flex items-center gap-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[#38BDF8] rounded-md"
        >
          <span
            aria-hidden="true"
            className="flex h-8 w-8 items-center justify-center rounded-md bg-[#132845] border border-[#D9B352]/40"
          >
            <Activity className="h-4 w-4 text-[#D9B352]" />
          </span>
          <span className="font-display text-lg font-bold tracking-tight text-white whitespace-nowrap">
            DATAFIX
          </span>
        </button>

        <button
          type="button"
          onClick={onCloseMobile}
          aria-label="Close navigation menu"
          className="lg:hidden inline-flex h-9 w-9 items-center justify-center rounded-md text-slate-300 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#38BDF8]"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Navigation items */}
      <nav aria-label="Primary navigation" className="flex-1 overflow-y-auto px-3 py-4">
        <p className="px-3 pb-2 text-xs font-medium text-slate-400">
          Workspace Pipeline
        </p>
        <ul className="space-y-1">
          {NAVIGATION_ITEMS.map((item) => {
            const Icon = SECTION_ICONS[item.id];
            const isActive = activeSection === item.id;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => handleNavClick(item.id)}
                  aria-current={isActive ? 'page' : undefined}
                  className={`group flex w-full items-center justify-between rounded-md px-3 py-2.5 text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#38BDF8] ${
                    isActive
                      ? 'bg-[#163155] text-white'
                      : 'text-slate-300 hover:bg-white/6 hover:text-white'
                  }`}
                >
                  <span className="flex items-center gap-3 min-w-0">
                    <Icon
                      className={`h-4 w-4 shrink-0 transition-colors ${
                        isActive
                          ? 'text-[#38BDF8]'
                          : 'text-slate-400 group-hover:text-slate-200'
                      }`}
                    />
                    <span className="truncate whitespace-nowrap">{item.label}</span>
                  </span>
                  <span
                    className={`font-mono text-xs tabular-nums ${
                      isActive ? 'text-[#D9B352]' : 'text-slate-500'
                    }`}
                  >
                    {item.stepNumber}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Quiet workspace footer */}
      <div className="border-t border-white/10 px-5 py-4 text-xs text-slate-400">
        <p className="font-medium text-slate-200">DataFix Quality Engine</p>
        <p className="mt-1 tabular-nums text-slate-400">
          {datasetCount} active {datasetCount === 1 ? 'dataset' : 'datasets'} in session
        </p>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop fixed sidebar */}
      <aside className="hidden lg:fixed lg:inset-y-0 lg:left-0 lg:z-30 lg:block lg:w-64">
        {sidebarContent}
      </aside>

      {/* Mobile slide-over drawer */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-50 flex lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation menu"
        >
          <div
            className="fixed inset-0 bg-[#071221]/60 transition-opacity"
            onClick={onCloseMobile}
            aria-hidden="true"
          />
          <div className="relative z-10 w-72 max-w-[82vw] h-full shadow-xl">
            {sidebarContent}
          </div>
        </div>
      )}
    </>
  );
}
