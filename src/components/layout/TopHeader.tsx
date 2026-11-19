import { Menu, Upload } from 'lucide-react';
import { NAVIGATION_ITEMS } from '../../config/navigation';
import type { NavSectionId } from '../../types/datafix';

interface TopHeaderProps {
  activeSection: NavSectionId;
  onOpenMobileMenu: () => void;
  onNavigateUpload: () => void;
  activeDatasetName?: string;
}

export function TopHeader({
  activeSection,
  onOpenMobileMenu,
  onNavigateUpload,
  activeDatasetName,
}: TopHeaderProps) {
  const currentNav =
    NAVIGATION_ITEMS.find((item) => item.id === activeSection) ??
    NAVIGATION_ITEMS[0];

  return (
    <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-4 border-b border-slate-200 bg-white px-4 sm:px-6">
      <div className="flex items-center gap-3 min-w-0">
        <button
          type="button"
          onClick={onOpenMobileMenu}
          aria-label="Open navigation menu"
          className="lg:hidden inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-slate-200 text-[#0B192C] hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0284C7]"
        >
          <Menu className="h-5 w-5" />
        </button>

        <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm min-w-0">
          <span className="hidden sm:inline font-display font-semibold text-[#0B192C] whitespace-nowrap">
            DataFix
          </span>
          <span aria-hidden="true" className="hidden sm:inline text-slate-300">
            /
          </span>
          <span className="font-display sm:font-sans font-semibold sm:font-medium text-[#0B192C] sm:text-slate-700 truncate">
            {currentNav.label}
          </span>
          {activeDatasetName && activeSection !== 'dashboard' && (
            <>
              <span aria-hidden="true" className="hidden md:inline text-slate-300">
                ·
              </span>
              <span className="hidden md:inline font-mono text-xs text-slate-500 truncate max-w-[220px]">
                {activeDatasetName}
              </span>
            </>
          )}
        </nav>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        {activeSection !== 'upload' && activeSection !== 'dashboard' && (
          <button
            type="button"
            onClick={onNavigateUpload}
            className="inline-flex items-center gap-1.5 sm:gap-2 rounded-md bg-[#0B192C] px-3 sm:px-4 py-2 text-xs sm:text-sm font-medium text-white transition-colors duration-150 hover:bg-[#163155] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0284C7] focus-visible:ring-offset-2 whitespace-nowrap shrink-0"
          >
            <Upload className="h-4 w-4 text-[#38BDF8]" />
            <span className="sm:hidden">Upload</span>
            <span className="hidden sm:inline">Upload Dataset</span>
          </button>
        )}
      </div>
    </header>
  );
}
