import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { renderReleaseNotesHtml, safeLinkHref } from '../../lib/markdown'

/**
 * 发布说明的 Markdown 正文。
 *
 * HTML 字符串由 `lib/markdown` 生成：mdast → hast → **净化** → 字符串。
 * 净化在字符串生成之前完成（净化器看到的是 hast 元素树，能按标签/属性/协议
 * 精确剔除），所以这里插入的 HTML 只含白名单内的标签与属性。
 *
 * 链接点击不走窗口导航：交主进程按协议白名单判定后用系统浏览器打开。
 */
export default function MarkdownView(props: {
  source: string
  openLink: (url: string) => void
}): ReactNode {
  const { source, openLink } = props
  const html = useMemo(() => renderReleaseNotesHtml(source), [source])

  /**
   * 事件委托：正文里的链接统一拦下，交给主进程打开。
   * 目标元素用 `closest('a')` 找 —— 嵌套标签（<strong><a>…）同样能命中。
   */
  const onClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    const target = event.target
    if (!(target instanceof Element)) return
    const anchor = target.closest('a')
    if (!(anchor instanceof HTMLAnchorElement)) return
    const href = safeLinkHref(anchor.getAttribute('href') ?? '')
    // 不可信协议不打开：净化器本已剥掉 href，这里再兜一层。
    if (href === null) return
    // 交给主进程的系统浏览器打开，不让 Electron 窗口自己导航。
    event.preventDefault()
    openLink(href)
  }

  return (
    <div className="markdown-body" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
  )
}
