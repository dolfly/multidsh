import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import { toHast } from 'mdast-util-to-hast'
import { defaultSchema, sanitize } from 'hast-util-sanitize'
import { toHtml } from 'hast-util-to-html'
import type { Root } from 'mdast'
import type { Schema } from 'hast-util-sanitize'

/**
 * 发布说明的 Markdown 渲染：**mdast → hast → 净化 → HTML 字符串**。
 *
 * 解析用 dsh 同款 micromark/mdast 生态（`mdast-util-from-markdown` + GFM 扩展），
 * 净化用 `hast-util-sanitize`（GitHub 同款），最终 HTML 字符串交给渲染层插入。
 *
 * 安全由三道闸共同保证：
 * - **净化 schema**（本文件 `RELEASE_NOTES_SCHEMA`）：只放行发布说明该有的标签与属性；
 *   协议白名单收紧到 http/https/mailto；远程图片与表单控件一律不渲染。
 * - **链接处理**（`safeLinkHref`）：`javascript:` / `data:` / `file:` / 相对路径不产生 href。
 * - **原始 HTML 不解析**：`mdast-util-to-hast` 默认把 raw 节点按纯文本处理，
 *   因此正文里的 `<script>`、`<img onerror=…>` 只会以字面量显示，不会进入 DOM。
 */

/** 可点击链接的协议白名单（与 dsh 渲染层一致）。 */
const LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/**
 * 判定链接是否可点击；不可点击时调用方按纯文本渲染。
 * 带凭据的 URL（`https://user:pass@host/`）一并拒绝。
 */
export function safeLinkHref(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (!LINK_PROTOCOLS.has(url.protocol)) return null
  if (url.username !== '' || url.password !== '') return null
  return url.toString()
}

/**
 * 净化 schema：在 GitHub 默认 schema 基础上收紧。
 *
 * 收紧点：
 * - 协议白名单只留 http/https/mailto（默认含 irc / ircs / xmpp）；
 * - 去掉 `input`（表单控件不该出现在只读正文里；默认 schema 允许 checkbox 型 input）；
 * - 去掉 `img`（远程图片不加载：既避免跟踪请求，也让布局不被外部资源撑开）；
 * - 去掉表单系列与 `button`、`select`、`textarea`（交互控件同理）。
 */
export const RELEASE_NOTES_SCHEMA: Schema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: ['http', 'https', 'mailto'],
    src: ['http', 'https'],
    cite: ['http', 'https'],
    longDesc: ['http', 'https']
  },
  tagNames: (defaultSchema.tagNames ?? []).filter(
    (tag) =>
      ![
        'input',
        'img',
        'form',
        'button',
        'select',
        'option',
        'textarea',
        'label',
        'fieldset'
      ].includes(tag)
  ),
  attributes: {
    ...defaultSchema.attributes,
    // 链接只保留 href。
    a: ['href'],
    // 代码块保留语言类名（```bash → class="language-bash"）。
    code: [['className', /^language-./]],
    // 表格单元格不带属性。
    th: [],
    td: []
  }
}

/** 解析 Markdown 为 mdast 树。GFM 扩展（表格、删除线、任务列表、自动链接）随附。 */
export function parseReleaseNotes(source: string): Root {
  return fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()]
  })
}

/**
 * Markdown → 净化后的 HTML 字符串。
 *
 * 净化在 `toHtml` **之前**完成：净化器看到的是 hast 元素树，能按标签/属性/协议
 * 精确剔除；先生成字符串再净化就只剩正则可用了。
 */
export function renderReleaseNotesHtml(source: string): string {
  const tree = parseReleaseNotes(source)
  const hast = toHast(tree)
  return toHtml(sanitize(hast, RELEASE_NOTES_SCHEMA))
}
