import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseReleaseNotes, renderReleaseNotesHtml, safeLinkHref } from './markdown'

/**
 * 更新内容的 Markdown 渲染：解析 → 净化 → HTML 字符串。
 *
 * 守卫两条线：
 * - 渲染：发布说明常用的语法（标题、列表、代码块、表格、引用、删除线）都出 HTML；
 * - 安全：净化器剥掉脚本、事件属性、危险协议与表单控件。
 */

/** 取节点的子节点数组。 */
function childrenOf(node: unknown): unknown[] {
  const children = (node as { children?: unknown }).children
  return Array.isArray(children) ? children : []
}

/** 收集树里所有节点的 type，便于断言结构。 */
function nodeTypes(tree: unknown): string[] {
  const found: string[] = []
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return
    const type = (node as { type?: unknown }).type
    if (typeof type === 'string') found.push(type)
    for (const child of childrenOf(node)) visit(child)
  }
  visit(tree)
  return found
}

describe('safeLinkHref', () => {
  it('放行 http、https 与 mailto', () => {
    expect(safeLinkHref('https://example.com/a')).toBe('https://example.com/a')
    expect(safeLinkHref('http://example.com/')).toBe('http://example.com/')
    expect(safeLinkHref('mailto:dev@example.com')).toBe('mailto:dev@example.com')
  })

  it('拒绝能执行脚本或拉起本地程序的协议', () => {
    expect(safeLinkHref('javascript:alert(1)')).toBeNull()
    expect(safeLinkHref('data:text/html,<script>alert(1)</script>')).toBeNull()
    expect(safeLinkHref('file:///etc/passwd')).toBeNull()
    expect(safeLinkHref('vbscript:msgbox(1)')).toBeNull()
  })

  it('拒绝相对路径与无法解析的输入', () => {
    expect(safeLinkHref('/docs/a')).toBeNull()
    expect(safeLinkHref('./a')).toBeNull()
    expect(safeLinkHref('')).toBeNull()
    expect(safeLinkHref('not a url')).toBeNull()
  })

  it('拒绝内嵌凭据的地址', () => {
    expect(safeLinkHref('https://user:pass@example.com/')).toBeNull()
  })
})

describe('parseReleaseNotes', () => {
  it('解析标题、列表与强调', () => {
    const types = nodeTypes(parseReleaseNotes('# 标题\n\n- 项一\n- 项二\n\n**粗体**'))
    expect(types).toContain('heading')
    expect(types).toContain('list')
    expect(types).toContain('listItem')
    expect(types).toContain('strong')
  })

  it('解析围栏代码块与行内代码', () => {
    const types = nodeTypes(parseReleaseNotes('```bash\nnpm i demo\n```\n\n`inline`'))
    expect(types).toContain('code')
    expect(types).toContain('inlineCode')
  })

  it('解析 GFM 表格、删除线与任务列表', () => {
    const types = nodeTypes(
      parseReleaseNotes('| a | b |\n|---|---|\n| 1 | 2 |\n\n~~删~~\n\n- [x] 完成')
    )
    expect(types).toContain('table')
    expect(types).toContain('tableRow')
    expect(types).toContain('tableCell')
    expect(types).toContain('delete')
  })

  it('解析引用块与分隔线', () => {
    const types = nodeTypes(parseReleaseNotes('> 引用\n\n---\n'))
    expect(types).toContain('blockquote')
    expect(types).toContain('thematicBreak')
  })

  it('原始 HTML 被标为 html 节点（不是可渲染元素）', () => {
    const types = nodeTypes(parseReleaseNotes('<script>alert(1)</script>'))
    // 解析器如实标出原始 HTML：它不是 mdast 的元素节点，渲染层按纯文本显示，不执行。
    expect(types).toContain('html')
    expect(types).not.toContain('element')
  })

  it('链接节点保留原始地址（协议判定在净化与渲染层做）', () => {
    const tree = parseReleaseNotes('[点我](javascript:alert(1))')
    const types = nodeTypes(tree)
    expect(types).toContain('link')
    // 判定函数对该地址必须给出不可点击
    expect(safeLinkHref('javascript:alert(1)')).toBeNull()
  })

  it('节点的字段约定：图片的替代文本在 alt，代码与原始 HTML 在 value', () => {
    const tree = parseReleaseNotes(
      '![替代文本](https://x.com/a.png)\n\n```js\ncode()\n```\n\n<div>raw</div>'
    )
    const find = (type: string): Record<string, unknown> | null => {
      let hit: Record<string, unknown> | null = null
      const visit = (node: unknown): void => {
        if (hit !== null || node === null || typeof node !== 'object') return
        if ((node as { type?: string }).type === type) {
          hit = node as Record<string, unknown>
          return
        }
        for (const child of childrenOf(node)) visit(child)
      }
      visit(tree)
      return hit
    }
    // alt 写错成 value 会让图片的替代文本整个消失（界面上什么都不剩）。
    expect(find('image')?.['alt']).toBe('替代文本')
    expect(find('code')?.['value']).toBe('code()')
    expect(find('html')?.['value']).toBe('<div>raw</div>')
  })

  it('空文本解析为空树', () => {
    expect(nodeTypes(parseReleaseNotes(''))).toEqual(['root'])
  })
})

describe('renderReleaseNotesHtml', () => {
  it('渲染标题、列表、强调、删除线', () => {
    const html = renderReleaseNotesHtml('# 标题\n\n- 项一\n\n**粗** 与 ~~删~~')
    expect(html).toContain('<h1>标题</h1>')
    expect(html).toContain('<li>项一</li>')
    expect(html).toContain('<strong>粗</strong>')
    expect(html).toContain('<del>删</del>')
  })

  it('渲染表格、引用与代码块', () => {
    const html = renderReleaseNotesHtml(
      '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n> 引用\n\n```bash\nls\n```'
    )
    expect(html).toContain('<table>')
    expect(html).toContain('<th>a</th>')
    expect(html).toContain('<td>1</td>')
    expect(html).toContain('<blockquote>')
    expect(html).toContain('<pre>')
    // 代码块保留语言类名。
    expect(html).toContain('language-bash')
  })

  it('剥掉 script 标签与事件属性', () => {
    const html = renderReleaseNotesHtml(
      '<script>alert(1)</script>\n\n<div onclick="alert(1)">文本</div>'
    )
    expect(html).not.toContain('<script')
    expect(html).not.toContain('onclick')
    expect(html).not.toContain('alert(1)')
  })

  it('剥掉危险协议的 href', () => {
    const html = renderReleaseNotesHtml('[点我](javascript:alert(1))')
    expect(html).not.toContain('javascript:')
    // 净化器保留 <a> 元素但剥掉危险协议：链接文字保留，只是没有可点的地址。
    expect(html).toContain('点我')
    expect(html).toContain('<a>')
    expect(html).not.toContain('href=')
  })

  it('剥掉远程图片（不加载外部资源）', () => {
    const html = renderReleaseNotesHtml('![图](https://evil.example.com/track.png)')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('evil.example.com')
  })

  it('剥掉表单控件与 iframe', () => {
    const html = renderReleaseNotesHtml(
      '<iframe src="https://evil.com"></iframe>\n\n<button onclick="x()">点</button>'
    )
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('<button')
  })

  it('保留 http(s) 链接的 href', () => {
    const html = renderReleaseNotesHtml('[文档](https://example.com/docs)')
    expect(html).toContain('href="https://example.com/docs"')
  })
})

describe('渲染层插入的 HTML 必经净化', () => {
  it('MarkdownView 只插入 renderReleaseNotesHtml 的产物', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/renderer/src/components/detail/MarkdownView.tsx'),
      'utf8'
    )
    // dangerouslySetInnerHTML 的数据源必须是净化后的字符串。
    expect(source).toContain('renderReleaseNotesHtml')
    expect(source).toMatch(/dangerouslySetInnerHTML=\{\{\s*__html:\s*html\s*\}\}/)
    // 不得有第二条不经净化的 HTML 通道。
    expect(source.match(/dangerouslySetInnerHTML/g) ?? []).toHaveLength(1)
  })

  it('净化发生在生成字符串之前（不是事后用正则清洗）', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/lib/markdown.ts'), 'utf8')
    // 只看 renderReleaseNotesHtml 函数体：import 语句里的名字不算调用。
    const body = source.slice(source.indexOf('export function renderReleaseNotesHtml'))
    // 净化后的 hast 才是字符串化的输入：toHtml(sanitize(...))。
    expect(body).toMatch(/toHtml\(\s*sanitize\(/)
    expect(body).not.toMatch(/toHtml\(\s*hast\s*\)/)
  })
})
