import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseReleaseNotes, safeLinkHref } from './markdown'

/**
 * 更新内容的 Markdown 解析与链接安全判定。
 *
 * 守卫两条线：
 * - 解析：发布说明常用的语法（标题、列表、代码块、表格、引用、删除线）都能出结构；
 * - 安全：只有 http(s)/mailto 能成为可点击链接，其余一律降级为纯文本。
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

  it('原始 HTML 被标为 html 节点（不是可渲染元素），由渲染层按文本输出', () => {
    const types = nodeTypes(parseReleaseNotes('<script>alert(1)</script>'))
    // 解析器如实标出原始 HTML：它不是 mdast 的元素节点，渲染层按纯文本显示，不执行。
    expect(types).toContain('html')
    expect(types).not.toContain('element')
  })

  it('链接节点保留原始地址（协议判定在渲染层做）', () => {
    const tree = parseReleaseNotes('[点我](javascript:alert(1))')
    const types = nodeTypes(tree)
    expect(types).toContain('link')
    // 判定函数对该地址必须给出不可点击
    expect(safeLinkHref('javascript:alert(1)')).toBeNull()
  })

  it('空文本解析为空树', () => {
    expect(nodeTypes(parseReleaseNotes(''))).toEqual(['root'])
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
})

describe('渲染层不产生 HTML 字符串', () => {
  it('MarkdownView 不使用 dangerouslySetInnerHTML（渲染层唯一能注入 HTML 的口子）', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/renderer/src/components/detail/MarkdownView.tsx'),
      'utf8'
    )
    // 注释里可以提到这个名字；这里查的是**实际用法**（属性赋值）。
    expect(source).not.toMatch(/dangerouslySetInnerHTML\s*=\s*\{/)
    // 也没有把 mdast 拼成 HTML 字符串再塞进 DOM 的变体。
    expect(source).not.toMatch(/\binnerHTML\s*=/)
  })

  it('渲染层不直接用原始地址当 href（协议判定必须经 safeLinkHref）', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/renderer/src/components/detail/MarkdownView.tsx'),
      'utf8'
    )
    // href 只允许来自 safeLinkHref 的结果。
    expect(source).toContain('safeLinkHref')
    // 未经判定的原始地址不得直接写进 href 属性。
    expect(source).not.toMatch(/href=\{[^}]*\.url/)
  })
})
