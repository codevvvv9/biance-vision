import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import i18n from '../i18n'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
}

/**
 * 渲染期错误边界：捕获 lazy chunk 加载失败（部署后旧 HTML 引用失效 hash、网络抖动）等渲染异常，
 * 避免错误穿透到根部导致整棵树卸载白屏；兜底提供刷新重试（lazy 的 rejection 会被缓存，必须 reload 重新拉取）
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('错误边界捕获渲染异常', error, info)
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="auth-wrap">
          <div
            className="auth-loading"
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}
          >
            {i18n.t('common:error.pageFailed')}
            <button className="btn btn-ghost" onClick={() => window.location.reload()}>
              {i18n.t('common:error.reload')}
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
