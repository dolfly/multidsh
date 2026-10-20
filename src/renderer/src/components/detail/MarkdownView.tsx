import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { parseReleaseNotes, safeLinkHref } from '../../lib/markdown'

/**
 * 发布说明的 Markdown 渲染。
 *
 * 解析与链接安全判定见 `lib/markdown`（用 dsh 同款 micromark/mdast 生态）。
 * 渲染时把 mdast 节点映射成 React 元素，全程不生成 HTML 字符串、
 * 不走 dangerouslySetInnerHTML，因此正文里的原始 HTML 一律不执行（按文本处理）。
 */

/** mdast 文本节点带 `value`；其余节点无此字段。 */
interface WithValue {
  value?: string
}

interface WithDepth {
  depth?: number
}

interface WithUrl {
  url?: string
}

interface WithOrdered {
  ordered?: boolean
  start?: number | null
}

interface WithLang {
  lang?: string | null
}

/** 取节点的子节点数组。 */
function childrenOf(node: unknown): unknown[] {
  const children = (node as { children?: unknown }).children
  return Array.isArray(children) ? children : []
}

/** 行内节点的渲染。 */
function renderInline(node: unknown, key: string, openLink: (url: string) => void): ReactNode {
  const type = (node as { type?: string }).type
  switch (type) {
    case 'text':
      return (node as WithValue).value ?? ''
    case 'inlineCode':
      return (
        <code className="md-code" key={key}>
          {(node as WithValue).value ?? ''}
        </code>
      )
    case 'strong':
      return (
        <strong key={key}>
          {childrenOf(node).map((child, index) => renderInline(child, `${key}-${index}`, openLink))}
        </strong>
      )
    case 'emphasis':
      return (
        <em key={key}>
          {childrenOf(node).map((child, index) => renderInline(child, `${key}-${index}`, openLink))}
        </em>
      )
    case 'delete':
      return (
        <del key={key}>
          {childrenOf(node).map((child, index) => renderInline(child, `${key}-${index}`, openLink))}
        </del>
      )
    case 'break':
      return <br key={key} />
    case 'link': {
      const href = safeLinkHref((node as WithUrl).url ?? '')
      const label = childrenOf(node).map((child, index) =>
        renderInline(child, `${key}-${index}`, openLink)
      )
      // 不可信协议降级为纯文本：链接文本照常显示，但不会成为可点击的 href。
      if (href === null) return <span key={key}>{label}</span>
      return (
        <a
          key={key}
          className="md-link"
          href={href}
          onClick={(event) => {
            // 交给主进程的系统浏览器打开，不让 Electron 窗口自己导航。
            event.preventDefault()
            openLink(href)
          }}
        >
          {label}
        </a>
      )
    }
    case 'image': {
      // 远程图片不加载：只保留 alt 文本。
      return <span key={key}>{(node as WithValue).value ?? ''}</span>
    }
    case 'html':
      // 原始 HTML 不执行，按文本原样显示。
      return <span key={key}>{(node as WithValue).value ?? ''}</span>
    default:
      return (
        <span key={key}>
          {childrenOf(node).map((child, index) => renderInline(child, `${key}-${index}`, openLink))}
        </span>
      )
  }
}

/** 段落等节点的行内内容。 */
function renderInlineChildren(
  node: unknown,
  key: string,
  openLink: (url: string) => void
): ReactNode {
  return childrenOf(node).map((child, index) => renderInline(child, `${key}-${index}`, openLink))
}

/** 块级节点的渲染。 */
function renderBlock(node: unknown, key: string, openLink: (url: string) => void): ReactNode {
  const type = (node as { type?: string }).type
  switch (type) {
    case 'paragraph':
      return <p key={key}>{renderInlineChildren(node, key, openLink)}</p>
    case 'heading': {
      const depth = Math.min(Math.max((node as WithDepth).depth ?? 1, 1), 6)
      const Tag = `h${depth}` as 'h1'
      return <Tag key={key}>{renderInlineChildren(node, key, openLink)}</Tag>
    }
    case 'code':
      return (
        <pre className="md-pre" key={key}>
          <code>{(node as WithLang).lang ?? ''}</code>
          {(node as WithValue).value ?? ''}
        </pre>
      )
    case 'blockquote':
      return (
        <blockquote key={key}>
          {childrenOf(node).map((child, index) => renderBlock(child, `${key}-${index}`, openLink))}
        </blockquote>
      )
    case 'list': {
      const ordered = (node as WithOrdered).ordered === true
      const start = (node as WithOrdered).start ?? null
      const items = childrenOf(node)
      const Tag = ordered ? 'ol' : 'ul'
      return (
        <Tag key={key} start={ordered && start !== null ? start : undefined}>
          {items.map((item, index) => (
            <li key={`${key}-${index}`} className="md-task">
              {childrenOf(item).map((child, childIndex) =>
                renderBlock(child, `${key}-${index}-${childIndex}`, openLink)
              )}
            </li>
          ))}
        </Tag>
      )
    }
    case 'table':
      return renderTable(node, key, openLink)
    case 'thematicBreak':
      return <hr key={key} />
    case 'html':
      // 原始 HTML 不执行，按文本原样显示。
      return <div key={key}>{(node as WithValue).value ?? ''}</div>
    default:
      return (
        <div key={key}>
          {childrenOf(node).map((child, index) => renderBlock(child, `${key}-${index}`, openLink))}
        </div>
      )
  }
}

/** 表格：表头行来自 `tableRow` 的第一个子节点。 */
function renderTable(node: unknown, key: string, openLink: (url: string) => void): ReactNode {
  const rows = childrenOf(node)
  const [head, ...body] = rows
  const headCells = head === undefined ? [] : childrenOf(head)
  return (
    <div className="md-table-wrap" key={key}>
      <table className="md-table">
        {head !== undefined && (
          <thead>
            <tr>
              {headCells.map((cell, index) => (
                <th key={`${key}-h-${index}`}>
                  {childrenOf(cell).map((child, childIndex) =>
                    renderInline(child, `${key}-h-${index}-${childIndex}`, openLink)
                  )}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={`${key}-${rowIndex}`}>
              {childrenOf(row).map((cell, cellIndex) => (
                <td key={`${key}-${rowIndex}-${cellIndex}`}>
                  {childrenOf(cell).map((child, childIndex) =>
                    renderInline(child, `${key}-${rowIndex}-${cellIndex}-${childIndex}`, openLink)
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * 更新内容的 Markdown 正文。
 *
 * `openLink` 由调用方提供：交给主进程的系统浏览器打开（渲染层不做窗口导航）。
 */
export default function MarkdownView(props: {
  source: string
  openLink: (url: string) => void
}): ReactNode {
  const { source, openLink } = props
  const tree = useMemo(() => parseReleaseNotes(source), [source])
  return (
    <div className="markdown-body">
      {childrenOf(tree).map((child, index) => renderBlock(child, `b${index}`, openLink))}
    </div>
  )
}
