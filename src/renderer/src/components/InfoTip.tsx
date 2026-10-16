import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Icon } from '../lib/icons'

/**
 * 标题旁的说明入口：正文收进气泡，不占卡片版面。
 * hover 或键盘聚焦时显示；点击钉住（移开鼠标仍显示），
 * 再次点击、Esc 或点击气泡外部收起。
 */
export function InfoTip(props: { text: string; label: string }): ReactNode {
  const [pinned, setPinned] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)
  const bubbleId = useId()

  useEffect(() => {
    if (!pinned) return
    const closeOnOutside = (event: Event): void => {
      if (!rootRef.current?.contains(event.target as Node | null)) setPinned(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPinned(false)
    }
    document.addEventListener('pointerdown', closeOnOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [pinned])

  return (
    <span className="info-tip" ref={rootRef} data-open={pinned ? '' : undefined}>
      <button
        type="button"
        className="info-tip-btn"
        aria-label={props.label}
        aria-describedby={bubbleId}
        aria-expanded={pinned}
        onClick={() => setPinned((value) => !value)}
      >
        <Icon name="info" />
      </button>
      {/* 气泡常驻 DOM：aria-describedby 可被读屏读到，显示与否只由 CSS 决定。 */}
      <span className="info-tip-bubble" id={bubbleId} role="tooltip">
        {props.text}
      </span>
    </span>
  )
}

/**
 * 文本型说明气泡：包住被省略号截断的状态文本，hover 或键盘聚焦即显示完整内容。
 * 触发物是文本本身而非按钮：内部结构与 testid 保持原样，只多一层气泡容器；
 * 文本可聚焦（tabIndex=0），读屏经 aria-describedby 读到完整正文。
 */
export function HoverTip(props: { text: string; children: ReactNode }): ReactNode {
  const bubbleId = useId()
  return (
    <span className="info-tip" tabIndex={0} aria-describedby={bubbleId}>
      {props.children}
      <span className="info-tip-bubble" id={bubbleId} role="tooltip">
        {props.text}
      </span>
    </span>
  )
}
