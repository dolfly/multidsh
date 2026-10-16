import { useId } from 'react'
import type { ReactNode } from 'react'
import { Icon } from '../lib/icons'

/**
 * 标题旁的说明入口：正文收进气泡，不占卡片版面。
 * 只在 hover 或键盘聚焦时显示，点击不钉住 —— 点一下必然会先悬停，
 * 移开鼠标气泡就收起，不会在卡片上残留。
 * 触发物是可聚焦的问号图标（无点击行为），读屏经 aria-describedby 读到完整正文。
 */
export function InfoTip(props: { text: string; label: string }): ReactNode {
  const bubbleId = useId()
  return (
    <span className="info-tip">
      <span className="info-tip-btn" tabIndex={0} aria-label={props.label} aria-describedby={bubbleId}>
        <Icon name="help" />
      </span>
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
