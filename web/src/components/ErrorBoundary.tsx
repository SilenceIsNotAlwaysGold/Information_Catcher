"use client";

/**
 * 简单 React 错误边界——比 Next.js 的 generic "Application error" 更可读。
 * 在子树渲染崩时显示错误 message + stack（用户能直接复制给开发者）。
 */
import { Component, ErrorInfo, ReactNode } from "react";

type Props = { children: ReactNode; label?: string };
type State = { error: Error | null; info: ErrorInfo | null };

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null, info: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error, info: null };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ error, info });
    // 把错误打到 console，方便 F12 排查
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary]", this.props.label || "", error, info);
  }

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="m-6 p-4 rounded-lg border border-danger/40 bg-danger/5 text-danger-700">
        <div className="text-sm font-semibold mb-2">
          组件渲染崩了{this.props.label ? `（${this.props.label}）` : ""}
        </div>
        <div className="text-xs font-mono whitespace-pre-wrap break-all bg-default-50 p-2 rounded border">
          {error.name}: {error.message}
          {info?.componentStack ? "\n" + info.componentStack.slice(0, 800) : ""}
        </div>
        <button
          type="button"
          className="mt-3 text-xs underline text-primary"
          onClick={() => this.setState({ error: null, info: null })}
        >
          重试渲染
        </button>
      </div>
    );
  }
}
