import { useId } from 'react'
import type { ReactNode } from 'react'
import { Icon } from '../lib/icons'

/**
 * 气泡相对触发物的方位：
 * - below：右缘对齐触发物、向下展开（默认，触发物在右上角时最稳）；
 * - above：同上但向上展开，用于贴在滚动容器（对话框正文）底部的入口，向下会被容器裁掉；
 * - above-start：向上展开并改以左缘为锚向右展开，用于对话框左半侧的入口，
 *   否则向左展开的气泡会被对话框的 overflow 裁掉。
 */
type TipPlacement = 'below' | 'above' | 'above-start'

const PLACEMENT_CLASS: Record<TipPlacement, string> = {
  below: '',
  above: ' info-tip-above',
  'above-start': ' info-tip-above info-tip-start'
}

/**
 * 标题旁的说明入口：正文收进气泡，不占卡片版面。
 * 只在 hover 或键盘聚焦时显示，点击不钉住 —— 点一下必然会先悬停，
 * 移开鼠标气泡就收起，不会在卡片上残留。
 * 触发物是可聚焦的问号图标（无点击行为），读屏经 aria-describedby 读到完整正文。
 */
export function InfoTip(props: {
  text: string
  label: string
  placement?: TipPlacement
}): ReactNode {
  const bubbleId = useId()
  return (
    <span className={`info-tip${PLACEMENT_CLASS[props.placement ?? 'below']}`}>
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
