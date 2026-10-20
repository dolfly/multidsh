# 0010. 更新内容按 Markdown 渲染（引入 micromark/mdast 生态）

- 状态：已采纳
- 日期：2026-10（插件升级对话框加宽 + 更新内容 Markdown 渲染）

## 背景

插件安装/升级确认区里的「更新内容」取自 GitHub Release body 或仓库 CHANGELOG 片段——两者都是 **Markdown 原文**。此前该区域按纯文本渲染（`white-space: pre-wrap`），发布说明里的 `## 新增`、`- 功能项`、`| 表格 |`、`**强调**` 全部以字面量显示，表格挤成一行、代码块不换行，读者要自己把标记翻译一遍。

两条路可走：

1. 自写 Markdown 解析器；
2. 引入成熟库。

dsh 自身的前端已经选定 micromark/mdast 生态（`mdast-util-from-markdown` + `mdast-util-gfm` + `micromark-extension-gfm`，见 `@deepseek-ai/dsh-client-ui-primitives`）。与宿主同款意味着解析行为一致（GFM 表格、删除线、任务列表的边界处理相同），也避免自研解析器的长期维护与安全面。

## 决策

**引入 dsh 同款 micromark/mdast 生态**，渲染管线为：

```
Markdown → mdast → hast → 净化（hast-util-sanitize）→ HTML 字符串 → DOM
```

- 依赖：`mdast-util-from-markdown`、`mdast-util-gfm`、`micromark-extension-gfm`、`mdast-util-to-hast`、`hast-util-sanitize`、`hast-util-to-html`（及类型包 `@types/mdast`）。
- 依赖仍放在 `devDependencies`：`dependencies` 恒为空这条红线不变（见 [0002](./0002-zero-runtime-deps.md)）——devDependency 只影响「谁来安装它」，electron-vite 打包时照样解析并并入 `out/` 产物。
- **净化用 `hast-util-sanitize`**（GitHub 同款），schema 在其默认 schema 基础上收紧：
  - 协议白名单只留 http/https/mailto（默认含 irc / ircs / xmpp）；
  - 去掉 `input`（表单控件不该出现在只读正文里）、`img`（远程图片不加载：既避免跟踪请求，也让布局不被外部资源撑开）、`form` / `button` / `select` / `textarea` 等交互控件；
  - 链接只保留 `href`，代码块只保留 `language-*` 类名，表格单元格不带属性。
- **净化在生成字符串之前完成**：净化器看到的是 hast 元素树，能按标签/属性/协议精确剔除；先生成字符串再清洗就只剩正则可用了。
- **原始 HTML 不解析成元素**：`mdast-util-to-hast` 默认把 raw 节点按纯文本处理（与 GitHub 一致），因此正文里的 `<script>`、`<img onerror=…>` 只会以字面量显示，不会进入 DOM。为此**不引入** `rehype-raw` / `hast-util-raw` —— 解析原始 HTML 只会扩大攻击面，没有收益。
- **外链交给主进程**：渲染层不自己做窗口导航，点链接经 `app:openExternalLink` 通道，主进程按协议白名单（http/https/mailto）判定后交系统默认程序——`file:` / `search-ms:` 一类能拉起本地程序或读本地文件的协议在主进程侧被挡住。

### 被否决的备选

- **自写解析器**：几百行正则与状态机，长期要跟 CommonMark/GFM 边界同步，且安全面要自己保证；收益不抵成本。
- **AST → React 元素（不生成 HTML 字符串）**：不引入净化器即没有 HTML 注入面，安全性更高，但每种 Markdown 语法都要手写一次元素映射，GFM 新语法要跟着补；`hast-util-sanitize` 的 schema 覆盖面远超手写映射能追平的进度。
- **直接复用 `@deepseek-ai/dsh-client-ui-primitives` 的 `MarkdownText`**：该包自带 KaTeX、Shiki、终端/差异/JSON 卡片等一整套 UI 原语，与本应用的设计体系不一致，且把一大片无关代码带进产物。

## 后果

- 渲染层多了 6 个直接依赖（连带传递依赖约 50 个包），全部进 `out/renderer` 产物。
- `dangerouslySetInnerHTML` 出现在渲染层——这是全应用唯一一处，必须由「插入的字符串必经净化」这一条守住。单测锁住了两件事：插入点只有一处且数据源是 `renderReleaseNotesHtml` 的产物；净化发生在字符串化之前。
- 链接协议白名单有两处实现（渲染层判定能否成为 href、主进程判定能否交给系统打开），单测各覆盖一处。
- 升级确认框宽度从 560px 提到 616px（+10%），给表格与代码块留出横向空间。
