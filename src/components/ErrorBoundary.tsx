import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

interface Props {
  children: ReactNode;
  resetKey?: unknown;
  onGoHome: () => void;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary] uncaught render error:", error, info);
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  handleReload = () => {
    window.location.reload();
  };

  handleGoHome = () => {
    this.setState({ error: null });
    this.props.onGoHome();
  };

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="h-full bg-linear-to-b from-th-surface to-th-base flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-center px-8">
          <AlertTriangle size={48} className="text-th-text-disabled" />
          <p className="text-th-text-primary font-semibold text-lg">
            Something went wrong
          </p>
          <p className="text-th-text-muted text-sm max-w-md">
            An unexpected error caused this page to crash.
          </p>
          <div className="mt-2 flex gap-3">
            <button
              onClick={this.handleGoHome}
              className="px-6 py-2 bg-th-accent text-th-on-accent rounded-full text-sm font-bold hover:bg-th-accent-hover hover:scale-105 transition-[transform,background-color]"
            >
              Go home
            </button>
            <button
              onClick={this.handleReload}
              className="px-6 py-2 bg-th-surface-elevated text-th-text-primary border border-th-border rounded-full text-sm font-bold hover:scale-105 transition-transform"
            >
              Reload app
            </button>
          </div>
        </div>
      </div>
    );
  }
}
