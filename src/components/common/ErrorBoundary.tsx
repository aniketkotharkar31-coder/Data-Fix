import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      message: error.message || 'An unexpected rendering error occurred.',
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('DataFix UI boundary caught error:', error, info.componentStack);
  }

  private handleReset = () => {
    this.setState({ hasError: false, message: '' });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-white p-6 text-left"
        >
          <h2 className="text-base font-semibold text-[#0B192C]">
            View failed to render
          </h2>
          <p className="mt-1 text-sm text-slate-600">{this.state.message}</p>
          <button
            type="button"
            onClick={this.handleReset}
            className="mt-4 rounded-md bg-[#0B192C] px-4 py-2 text-xs font-medium text-white hover:bg-[#163155]"
          >
            Reload View
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
