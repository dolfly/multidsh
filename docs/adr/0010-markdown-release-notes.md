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

**引入 dsh 同款 micromark/mdast 生态**，解析结果为 **mdast 树**；渲染层把节点映射成 React 元素。

- 依赖：`mdast-util-from-markdown`、`mdast-util-gfm`、`micromark-extension-gfm`（及类型包 `@types/mdast`）。
- 依赖仍放在 `devDependencies`：`dependencies` 恒为空这条红线不变（见 [0002](./0002-zero-runtime-deps.md)）——devDependency 只影响「谁来安装它」，electron-vite 打包时照样解析并并入 `out/` 产物。
- **不生成 HTML 字符串**：不引入 `remark-rehype` + `rehype-stringify` + `rehype-sanitize` 这条链，也不用 `dangerouslySetInnerHTML`。mdast 节点直接映射成 React 元素，因此正文里的原始 HTML 一律不执行（按文本显示），没有 HTML 注入面。
- **链接安全**：只有 http(s)/mailto 能成为可点击的 href；`javascript:`、`data:`、`file:`、相对路径降级为纯文本（不产生 href 属性）。与 dsh 渲染层同一套协议白名单。
- **外链交给主进程**：渲染层不自己做窗口导航，点链接经新增的 `app:openExternalLink` 通道，主进程按协议白名单（http/https/mailto）判定后交系统默认程序——`file:` / `search-ms:` 一类能拉起本地程序或读本地文件的协议在主进程侧被挡住。

### 被否决的备选

- **自写解析器**：几百行正则与状态机，长期要跟 CommonMark/GFM 边界同步，且安全面要自己保证；收益不抵成本。
- **`marked` + DOMPurify**：产出 HTML 字符串，必须配净化器并走 `dangerouslySetInnerHTML`；比 AST 路线多一个注入面与一份净化器依赖。
- **直接复用 `@deepseek-ai/dsh-client-ui-primitives` 的 `MarkdownText`**：该包自带 KaTeX、Shiki、终端/差异/JSON 卡片等一整套 UI 原语，与本应用的设计体系不一致，且把一大片无关代码带进产物。

## 后果

- 渲染层多了 4 个直接依赖（连带 micromark 传递依赖约 40 个包），全部进 `out/renderer` 产物；产物体积增加约 100 kB（未压缩）。
- 链接协议白名单有两处实现（渲染层判定能否成为 href、主进程判定能否交给系统打开），单测各覆盖一处。
- 升级确认框宽度从 560px 提到 616px（+10%），给表格与代码块留出横向空间。
