import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'

/**
 * 已挂载浮层的关闭栈。Escape 与 Tab 都在 window 上处理(焦点未必落在对话框内,
 * div 级 onKeyDown 收不到),但只对栈顶一层生效:Escape 逐层关闭,Tab 只圈闭
 * 最上层对话框。
 */
const modalStack: Array<() => void> = []

/** 对话框内参与 Tab 顺序的候选元素;禁用、tabindex<0 与不可见项在收集时剔除。 */
const FOCUSABLE_SELECTOR = 'a[href], button, input, select, textarea, [tabindex]'

function tabbableWithin(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.tabIndex >= 0 && !element.hasAttribute('disabled') && element.getClientRects().length > 0
  )
}

/** 浮层容器:背景模糊 + 居中,点击背景关闭 */
export function Modal(props: {
  wide?: boolean
  /** 追加到对话框容器上的布局类，用于在默认与 wide 之外另定宽度档位。 */
  className?: string
  title: string
  sub?: string
  onClose: () => void
  footer?: ReactNode
  children: ReactNode
  testId?: string
  /** 将浮层限制在右侧主内容区，而非覆盖整个应用。 */
  scope?: 'app' | 'workspace'
  /** 关闭按钮的无障碍标签(由调用方经 t('common.close') 传入,保持本组件无 i18n 依赖) */
  closeLabel?: string
  /** 对话框已有 Escape 关闭语义时，可把右上角关闭按钮移出 Tab 顺序。 */
  closeButtonInTabOrder?: boolean
}): ReactNode {
  const dialogRef = useRef<HTMLDivElement>(null)
  // Escape 触发时读取最新 onClose:监听注册一次,避免闭包持有过期回调。
  const onCloseRef = useRef(props.onClose)
  onCloseRef.current = props.onClose

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    // 打开即把焦点移入对话框:否则焦点留在触发按钮上,Tab 会继续走背后的页面。
    // 焦点已在对话框内时不抢走,让正文里 autoFocus 的输入框保持焦点。
    if (dialog.contains(document.activeElement)) return
    dialog.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    const close = (): void => onCloseRef.current()
    modalStack.push(close)
    const onKeyDown = (event: KeyboardEvent): void => {
      if (modalStack[modalStack.length - 1] !== close) return
      const dialog = dialogRef.current
      if (!dialog) return
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
        return
      }
      if (event.key !== 'Tab') return
      // Tab 圈闭:焦点在对话框内时只在首尾之间往返,在外(含对话框容器本身)时拉回。
      const nodes = tabbableWithin(dialog)
      const active = document.activeElement
      const inside = active instanceof HTMLElement && nodes.includes(active)
      if (nodes.length === 0 || !inside) {
        event.preventDefault()
        if (nodes.length > 0) nodes[event.shiftKey ? nodes.length - 1 : 0]?.focus()
        else dialog.focus({ preventScroll: true })
        return
      }
      const first = nodes[0] as HTMLElement
      const last = nodes[nodes.length - 1] as HTMLElement
      if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      const index = modalStack.lastIndexOf(close)
      if (index !== -1) modalStack.splice(index, 1)
    }
  }, [])

  return (
    <div className={`overlay${props.scope === 'workspace' ? ' overlay-workspace' : ''}`} onClick={props.onClose}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        className={`modal${props.wide ? ' wide' : ''}${props.className ? ` ${props.className}` : ''}`}
        data-testid={props.testId}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h2>{props.title}</h2>
            {props.sub && <p className="sub">{props.sub}</p>}
          </div>
          <button
            className="x-btn"
            aria-label={props.closeLabel ?? 'Close'}
            tabIndex={props.closeButtonInTabOrder === false ? -1 : undefined}
            onClick={props.onClose}
          >
            ✕
          </button>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer && <div className="modal-foot">{props.footer}</div>}
      </div>
    </div>
  )
}
