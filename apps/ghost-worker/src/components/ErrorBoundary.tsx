import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ghost-worker ui]", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: 24,
            color: "#e8eaed",
            background: "#05070a",
            minHeight: "100vh",
            fontFamily: "system-ui, sans-serif",
          }}
        >
          <h1 style={{ fontSize: 16, marginBottom: 8 }}>Ghost Worker UI error</h1>
          <pre
            style={{
              fontSize: 12,
              color: "#f87171",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {this.state.error.message}
          </pre>
          <button
            type="button"
            style={{
              marginTop: 16,
              padding: "8px 14px",
              background: "#1a2332",
              border: "1px solid #334155",
              color: "#e8eaed",
              borderRadius: 6,
              cursor: "pointer",
            }}
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
