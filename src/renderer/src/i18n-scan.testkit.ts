import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * i18n 文案扫描核心。
 *
 * 按行检查硬编码中日韩文案，保留字符串、模板、正则和 JSX/HTML 文本节点，并保持原始行号；
 * 识别字面字符和 Unicode 转义。扫描入口接受 `{ path, text }[]`，与文件系统解耦，便于用合成
 * 源码验证边界情况。
 */

/** 中日韩统一表意文字 + 中文标点 + 全角字符 */
const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/

export interface SourceFile {
  /** 工作区相对 POSIX 路径（仅用于报告） */
  path: string
  text: string
}

export interface Violation {
  path: string
  /** 1-based 行号，与文件真实行号一致 */
  line: number
  /** 违规行（去注释后 trim 的代码文本） */
  text: string
}

export interface ScanOptions {
  /** 整行豁免：某行 trim 后命中即跳过**该行**，不会连带豁免同文件其它行 */
  allowedLiterals?: readonly RegExp[]
  /** 豁免 `console.*` 实参区间内的文案（主进程日志，只进终端） */
  logSinks?: boolean
}

const charAt = (text: string, index: number): string => text[index] ?? ''

/**
 * 前一个有意义 token 的类别，用于区分除号与正则字面量起点。
 * `value` 后的 `/` 是除号；`operator` 和 `statement` 允许正则字面量开始。
 */
type TokenContext = 'value' | 'operator' | 'statement'

/** 这些关键字之后可以紧跟表达式,因此可以紧跟正则字面量(`return /re/`、`case /re/:`) */
const KEYWORDS_BEFORE_EXPRESSION = new Set([
  'await',
  'case',
  'delete',
  'do',
  'else',
  'in',
  'instanceof',
  'new',
  'of',
  'return',
  'throw',
  'typeof',
  'void',
  'yield'
])

/**
 * 这些关键字后面的 `(` 是**控制语句的括号**,它的 `)` 之后是一条新语句 ——
 * 所以 `if (ok) /re/.test(s)`、`while (ok) /re/.test(s)`、`for (;;) /re/.test(s)` 里的 `/` 是正则。
 * 普通括号的 `)` 之后是值(`(a + b) / 2`),`/` 仍是除号。
 * **例外**:`for await (` 的 `(` 前面一个词是 `await`(不是 `for`),见 `isForAwaitParen`。
 */
const CONTROL_PAREN_KEYWORDS = new Set(['catch', 'for', 'if', 'switch', 'while', 'with'])

/**
 * `for await (...)` 的括号属于控制语句括号。
 * 裸 `await (...)` 仍按普通括号处理，后续 `/` 应视为除号。
 */
const isForAwaitParen = (source: string, parenIndex: number): boolean => {
  let cursor = parenIndex - 1
  const skipSpaceBack = (): void => {
    while (cursor >= 0 && /\s/.test(charAt(source, cursor))) cursor -= 1
  }
  const wordBack = (): string => {
    const end = cursor + 1
    while (cursor >= 0 && /[A-Za-z0-9_$]/.test(charAt(source, cursor))) cursor -= 1
    return source.slice(cursor + 1, end)
  }
  skipSpaceBack()
  if (wordBack() !== 'await') return false
  skipSpaceBack()
  return wordBack() === 'for'
}

/** `{` 前面是这些**标点**时,它是对象字面量 / 解构模式,而不是块语句 */
const EXPRESSION_BRACE_AFTER_PUNCT = new Set(['=', '(', '[', ',', ':', '?'])

/**
 * `{` 前的这些关键字表示对象字面量或解构模式。
 * `void` 和 `typeof` 不在此列，以避免把带返回类型的函数体误判为对象字面量。
 */
const EXPRESSION_BRACE_AFTER_WORD = new Set([
  'await',
  'case',
  'default',
  'export',
  'return',
  'yield'
])

const isIdentStart = (char: string): boolean => /[A-Za-z_$]/.test(char) || char.charCodeAt(0) > 0x7f

const isIdentPart = (char: string): boolean =>
  /[A-Za-z0-9_$]/.test(char) || char.charCodeAt(0) > 0x7f

/** JSX/HTML 标签名与属性名允许的字符(`-` 给 Web Component,`:` 给命名空间,`.` 给成员表达式) */
const isTagChar = (char: string): boolean => /[A-Za-z0-9_$.:-]/.test(char)

/**
 * 按扩展名确定扫描模式：`.tsx` 保留 JSX 文本节点，`.html` 保留标签间文本，其他文件按代码扫描。
 */
export type StripMode = 'code' | 'jsx' | 'html'

/** 按扩展名选模式:未知扩展名一律 `code`(保守:不引入 JSX/HTML 文本态) */
export const modeForPath = (path: string): StripMode => {
  if (path.endsWith('.tsx')) return 'jsx'
  if (path.endsWith('.html')) return 'html'
  return 'code'
}

/**
 * 词法级移除注释，同时保留字符串、模板、正则和 JSX/HTML 文本节点。
 * 注释替换为等长空格以保持行号和列号；模板表达式递归按代码扫描。
 * `/` 的分类依赖 token 上下文：值后为除号，表达式或语句起点为正则。
 * 该分类是启发式的，优先把不确定的 `/` 视为正则，避免把后续内容当作注释移除。
 */
export function stripComments(source: string, mode: StripMode = 'code'): string {
  // 注释替换为等长空格，保留换行以维持原始位置。
  const chars = source.split('')
  // `.html` 的 `<script>` 和 `<style>` 正文在闭合标签前按代码扫描。
  let length = chars.length
  let index = 0
  /** 仅 `.tsx` 处理 JSX 文本节点；`.ts` 中的 `<` 表示泛型或比较。 */
  const jsx = mode === 'jsx'

  const blank = (from: number, to: number): void => {
    for (let cursor = from; cursor < to && cursor < length; cursor += 1) {
      if (chars[cursor] !== '\n') chars[cursor] = ' '
    }
  }

  /** 跳过字符串字面量（含转义；未闭合时在行尾收场，避免一个落单引号吞掉整个文件） */
  const skipString = (from: number, quote: string): number => {
    let cursor = from + 1
    while (cursor < length) {
      const char = charAt(source, cursor)
      if (char === '\\') {
        cursor += 2
        continue
      }
      cursor += 1
      if (char === quote || char === '\n') break
    }
    return cursor
  }

  /** 跳过正则字面量（含字符类 `[...]`、转义、flags）；未闭合时同样在行尾收场 */
  const skipRegExp = (from: number): number => {
    let cursor = from + 1
    let inClass = false
    while (cursor < length) {
      const char = charAt(source, cursor)
      if (char === '\\') {
        cursor += 2
        continue
      }
      if (char === '\n') return cursor
      if (char === '[') inClass = true
      else if (char === ']') inClass = false
      else if (char === '/' && !inClass) {
        cursor += 1
        while (cursor < length && /[a-z]/i.test(charAt(source, cursor))) cursor += 1
        return cursor
      }
      cursor += 1
    }
    return cursor
  }

  /** 跳过模板字面量内容（`index` 已越过开头的反引号）；`${...}` 交给 scanCode 当代码处理 */
  const skipTemplate = (): void => {
    while (index < length) {
      const char = charAt(source, index)
      if (char === '\\') {
        index += 2
        continue
      }
      if (char === '`') {
        index += 1
        return
      }
      if (char === '$' && charAt(source, index + 1) === '{') {
        index += 2
        scanCode(true)
        continue
      }
      index += 1
    }
  }

  /** 跳过 JSX 起始标签:`<` 已在 index 上。返回 `true` = 有子节点(非自闭合) */
  const skipJsxOpenTag = (): boolean => {
    index += 1 // '<'
    while (index < length && isTagChar(charAt(source, index))) index += 1
    for (;;) {
      if (index >= length) return false
      const char = charAt(source, index)
      const next = charAt(source, index + 1)
      if (/\s/.test(char)) {
        index += 1
        continue
      }
      // 开标签结束 → 后面是**文本节点**
      if (char === '>') {
        index += 1
        return true
      }
      if (char === '/' && next === '>') {
        index += 2
        return false
      }
      // JSX 属性之间的注释应移除。
      if (char === '/' && next === '/') {
        let end = index
        while (end < length && charAt(source, end) !== '\n') end += 1
        blank(index, end)
        index = end
        continue
      }
      if (char === '/' && next === '*') {
        let end = index + 2
        while (end < length && !(charAt(source, end) === '*' && charAt(source, end + 1) === '/')) {
          end += 1
        }
        const stop = Math.min(end + 2, length)
        blank(index, stop)
        index = stop
        continue
      }
      // 属性里的 `{…}` 是 JSX 表达式容器 → 代码
      if (char === '{') {
        index += 1
        scanCode(true)
        continue
      }
      if (char === '"' || char === "'") {
        index = skipString(index, char)
        continue
      }
      // 属性名 / `=` / spread:逐字符前进(**任何分支都前进**,不会挂死)
      index += 1
    }
  }

  /** 扫描 JSX 子节点：保留文本节点，递归扫描嵌套标签，并将 `{…}` 作为代码处理。 */
  const scanJsxChildren = (): void => {
    for (;;) {
      if (index >= length) return
      const char = charAt(source, index)
      if (char === '<') {
        if (charAt(source, index + 1) === '/') {
          index += 2
          while (index < length && isTagChar(charAt(source, index))) index += 1
          while (index < length && /\s/.test(charAt(source, index))) index += 1
          if (charAt(source, index) === '>') index += 1
          return
        }
        scanJsxElement()
        continue
      }
      if (char === '{') {
        index += 1
        scanCode(true)
        continue
      }
      index += 1 // 文本节点:**原样保留**,绝不当注释抹掉
    }
  }

  /** 扫完一个完整的 JSX 元素(`<a/>`、`<a>…</a>`,允许嵌套与 Fragment `<>`) */
  const scanJsxElement = (): void => {
    if (skipJsxOpenTag()) scanJsxChildren()
  }

  /** 跳过 HTML 标签本身(含引号包裹的属性值);标签之间的**文本**由 scanHtml 原样保留 */
  const skipHtmlTag = (): void => {
    index += 1 // '<'
    for (;;) {
      if (index >= length) return
      const char = charAt(source, index)
      if (char === '"' || char === "'") {
        index = skipString(index, char)
        continue
      }
      index += 1
      if (char === '>') return
    }
  }

  /**
   * HTML 注释 `<!-- -->`:等长抹成空格(行号不变)。
   * 返回 `true` = 已处理(调用方可继续);`false` = **找不到 `-->`,一个字都不抹** ——
   * 调用方必须自行前进(见 scanHtml),否则本函数「不推进且被反复调用」会把整个测试套件挂死。
   */
  const skipHtmlComment = (): boolean => {
    const closeAt = source.indexOf('-->', index + 4)
    if (closeAt === -1) return false
    blank(index, closeAt + 3)
    index = closeAt + 3
    return true
  }

  /** 读一眼当前位置的标签名(`<script` → `script`),小写化;不是标签则返回 '' */
  const peekTagName = (): string => {
    let cursor = index + 1
    if (charAt(source, cursor) === '/') cursor += 1
    let end = cursor
    while (end < length && /[A-Za-z0-9]/.test(charAt(source, end))) end += 1
    return source.slice(cursor, end).toLowerCase()
  }

  /**
   * `<script>` / `<style>` 正文:按 HTML 规范在第一个 `</script`/`</style` 处截断(浏览器就是这么做的),
   * 截断区间**按代码**扫描(注释照常剥离)。找不到结束标签时**不猜** —— 留给文本态(只会多报)。
   */
  const scanRawElement = (name: string): void => {
    const closeAt = source.toLowerCase().indexOf(`</${name}`, index)
    if (closeAt === -1) return
    const outer = length
    length = closeAt
    scanCode(false)
    length = outer
    index = closeAt
  }

  /** `.html` 保留标签外文本，并分别处理标签、doctype 和 HTML 注释。 */
  const scanHtml = (): void => {
    while (index < length) {
      const char = charAt(source, index)
      if (char === '<' && charAt(source, index + 1) === '!') {
        if (source.startsWith('<!--', index)) {
          // 已闭合 → 抹成空格;未闭合 → **不猜**:只前进一格,其余按文本保留(只会多报)
          // **必须前进**:`skipHtmlComment` 在找不到 `-->` 时一个字都不抹,直接 continue 会死循环
          if (skipHtmlComment()) continue
          index += 1
          continue
        }
        skipHtmlTag() // `<!doctype html>` 之类
        continue
      }
      if (char === '<' && /[A-Za-z/?]/.test(charAt(source, index + 1))) {
        const closing = charAt(source, index + 1) === '/'
        const tag = closing ? '' : peekTagName()
        skipHtmlTag()
        if (tag === 'script' || tag === 'style') scanRawElement(tag)
        continue
      }
      index += 1 // 文本节点:**原样保留**
    }
  }

  /**
   * 扫描一段「代码」：注释在这里被抹成空格，字符串/模板/正则整体跳过（内容原样保留）。
   * `stopAtBrace` 用于模板表达式与 JSX 表达式容器 —— 遇到**未配对的** `}` 即返回（该 `}` 属于它们）。
   */
  const scanCode = (stopAtBrace: boolean): void => {
    /** `value` = 除号;其余(operator/statement) = 正则。文件开头可以是以正则开头的表达式 */
    let context: TokenContext = 'operator'
    /** 最近一个有意义 token 的标点与词:只用于判断 `{` 是块语句还是对象字面量 */
    let lastPunct = ''
    let lastWord = ''
    /** 括号栈:`true` = 控制语句的括号(`if (…)`),其 `)` 之后是一条新语句 */
    const parenStack: boolean[] = []
    /** 花括号栈:`true` = 块语句,其 `}` 之后是新语句;`false` = 对象字面量,其 `}` 之后是值 */
    const braceStack: boolean[] = []
    /** 本行是否只见过空白:行首的 `/` 是 ASI 歧义点,取保守侧(见函数头) */
    let atLineStart = true
    let braceDepth = 0

    while (index < length) {
      const char = charAt(source, index)
      const next = charAt(source, index + 1)

      if (stopAtBrace && char === '}' && braceDepth === 0) {
        index += 1
        return
      }
      // —— 注释:只有不在字符串/模板/正则/文本节点里的 `//` `/*` 才是注释 ——
      //    这两种形态在**任何**位置都不可能是正则的起点,所以先于下面的 `/` 上下文判定
      if (char === '/' && next === '/') {
        let end = index
        while (end < length && charAt(source, end) !== '\n') end += 1
        blank(index, end)
        index = end
        continue
      }
      if (char === '/' && next === '*') {
        let end = index + 2
        while (end < length && !(charAt(source, end) === '*' && charAt(source, end + 1) === '/')) {
          end += 1
        }
        const stop = Math.min(end + 2, length)
        blank(index, stop)
        index = stop
        continue
      }
      // —— 正则字面量 vs 除号:由「前一个有意义 token」+ 行首歧义决定(见函数头说明) ——
      if (char === '/') {
        if (context === 'value' && !atLineStart) {
          index += 1
          context = 'operator'
          lastPunct = '/'
          lastWord = ''
          atLineStart = false
          continue
        }
        index = skipRegExp(index)
        context = 'value'
        lastPunct = '/'
        lastWord = ''
        atLineStart = false
        continue
      }
      if (char === '"' || char === "'") {
        index = skipString(index, char)
        context = 'value'
        lastPunct = char
        lastWord = ''
        atLineStart = false
        continue
      }
      if (char === '`') {
        index += 1
        skipTemplate()
        context = 'value'
        lastPunct = '`'
        lastWord = ''
        atLineStart = false
        continue
      }
      if (/\s/.test(char)) {
        // 换行重新打开「行首」:行首的 `/` 走保守侧(当正则跳过,不会抹掉 `//`)
        if (char === '\n') atLineStart = true
        index += 1
        continue
      }
      // JSX 标签仅在表达式可开始的位置识别。
      if (jsx && char === '<' && (isIdentStart(next) || next === '>') && context !== 'value') {
        scanJsxElement()
        context = 'value'
        lastPunct = '>'
        lastWord = ''
        atLineStart = false
        continue
      }
      if (isIdentStart(char)) {
        let end = index + 1
        while (end < length && isIdentPart(charAt(source, end))) end += 1
        const word = source.slice(index, end)
        index = end
        // 关键字之后可以开始一个表达式 → 正则;其余标识符是值 → 除号
        context = KEYWORDS_BEFORE_EXPRESSION.has(word) ? 'operator' : 'value'
        lastWord = word
        lastPunct = ''
        atLineStart = false
        continue
      }
      if (char >= '0' && char <= '9') {
        let end = index + 1
        while (end < length && /[0-9A-Za-z_.]/.test(charAt(source, end))) end += 1
        index = end
        context = 'value'
        lastWord = ''
        lastPunct = ''
        atLineStart = false
        continue
      }
      if (char === '(') {
        // 控制语句括号后的 `/` 可以开始正则；普通括号后的 `/` 是除号。
        // `for await (` 需要额外识别，因为前一个单词是 `await`。
        parenStack.push(CONTROL_PAREN_KEYWORDS.has(lastWord) || isForAwaitParen(source, index))
        index += 1
        context = 'operator'
        lastWord = ''
        lastPunct = '('
        atLineStart = false
        continue
      }
      if (char === ')') {
        // 控制语句的 `)` 之后可以开始正则；普通括号的 `)` 之后仍为值。
        const control = parenStack.pop() ?? false
        index += 1
        context = control ? 'statement' : 'value'
        lastWord = ''
        lastPunct = ')'
        atLineStart = false
        continue
      }
      if (char === '[') {
        index += 1
        context = 'operator'
        lastWord = ''
        lastPunct = '['
        atLineStart = false
        continue
      }
      if (char === ']') {
        index += 1
        context = 'value'
        lastWord = ''
        lastPunct = ']'
        atLineStart = false
        continue
      }
      if (char === '{') {
        // `}` 后的上下文取决于对应 `{` 是块语句还是对象字面量。
        const isObject =
          EXPRESSION_BRACE_AFTER_PUNCT.has(lastPunct) || EXPRESSION_BRACE_AFTER_WORD.has(lastWord)
        braceDepth += 1
        braceStack.push(!isObject)
        index += 1
        context = 'operator'
        lastWord = ''
        lastPunct = '{'
        atLineStart = false
        continue
      }
      if (char === '}') {
        // 块语句 → 新语句(`if (ok) { f() } /re/.test(s)`、`function f(){} /re/`、`class X{} /re/`);
        // 对象字面量 → 值之后(`const x = { a: 1 } / 2` 仍是除号)
        const block = braceStack.pop() ?? true
        braceDepth -= 1
        index += 1
        context = block ? 'statement' : 'value'
        lastWord = ''
        lastPunct = '}'
        atLineStart = false
        continue
      }
      if ((char === '+' || char === '-') && next === char) {
        // `x++ / 2`:自增/自减之后是「值的位置」,故仍是除号
        index += 2
        context = 'value'
        lastWord = ''
        lastPunct = char
        atLineStart = false
        continue
      }
      index += 1
      context = 'operator'
      lastWord = ''
      lastPunct = char
      atLineStart = false
    }
  }

  if (mode === 'html') scanHtml()
  else scanCode(false)
  return chars.join('')
}

/** 将 `\uXXXX` / `\u{XXXX}` 还原为字符，使转义写法的中文参与检查。 */
export function decodeUnicodeEscapes(text: string): string {
  return text.replace(
    /\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})/g,
    (_match: string, braced: string | undefined, fixed: string | undefined) =>
      String.fromCodePoint(Number.parseInt(braced ?? fixed ?? '', 16))
  )
}

/** 该行里所有中日韩字符所在的列号（含转义写法，列号取转义序列的起点） */
export function cjkColumns(line: string): number[] {
  const columns: number[] = []
  const escaped = /\\u\{[0-9a-fA-F]+\}|\\u[0-9a-fA-F]{4}/g
  let match = escaped.exec(line)
  while (match !== null) {
    if (CJK.test(decodeUnicodeEscapes(match[0]))) columns.push(match.index)
    match = escaped.exec(line)
  }
  for (let index = 0; index < line.length; index += 1) {
    if (CJK.test(charAt(line, index))) columns.push(index)
  }
  return columns
}

/** `console.*` 实参的字符区间 `[start, end)`：落在区间内的中文只进日志，不是用户可见文案 */
/** `/` 前出现这些字符或位于行首时，它可以开始正则字面量；其他位置视为除号。 */
const REGEX_START_AFTER = new Set([
  '',
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  ';',
  '+',
  '-',
  '*',
  '%',
  '<',
  '>',
  '~',
  '^'
])

export function logArgumentRegions(code: string): Array<readonly [number, number]> {
  const regions: Array<readonly [number, number]> = []
  const pattern = /\bconsole\s*\.\s*(?:log|info|warn|error|debug|trace)\s*\(/g
  let match = pattern.exec(code)
  while (match !== null) {
    let index = match.index + match[0].length
    let depth = 1
    /** 上一个非空白字符，用于判断 `/` 是正则起点还是除号。 */
    let lastSignificant = ''
    while (index < code.length && depth > 0) {
      const char = charAt(code, index)
      if (char === '"' || char === "'" || char === '`') {
        const quote = char
        index += 1
        while (index < code.length) {
          if (charAt(code, index) === '\\') {
            index += 2
            continue
          }
          const inner = charAt(code, index)
          index += 1
          if (inner === quote) break
        }
        lastSignificant = quote
        continue
      }
      // 正则字面量中的括号不影响 console 调用的实参深度。
      if (char === '/' && REGEX_START_AFTER.has(lastSignificant)) {
        index += 1
        let inClass = false
        while (index < code.length) {
          const inner = charAt(code, index)
          if (inner === '\\') {
            index += 2
            continue
          }
          if (inner === '\n') break
          index += 1
          if (inClass) {
            if (inner === ']') inClass = false
            continue
          }
          if (inner === '[') inClass = true
          else if (inner === '/') break
        }
        lastSignificant = '/'
        continue
      }
      if (char === '(') depth += 1
      else if (char === ')') depth -= 1
      if (!/\s/.test(char)) lastSignificant = char
      index += 1
    }
    regions.push([match.index + match[0].length, index])
    // 从实参右括号之后继续搜索下一个 `console.*` 调用。
    pattern.lastIndex = index
    match = pattern.exec(code)
  }
  return regions
}

/**
 * 扫描源码并返回违规位置。调用方将扫描结果与登记清单作集合比对，避免过滤已登记项后丢失新增或过期信息。
 */
export function scanSources(files: readonly SourceFile[], options: ScanOptions = {}): Violation[] {
  const violations: Violation[] = []
  for (const file of files) {
    // 按路径选择模式：`.tsx` 保留 JSX 文本，`.html` 保留标签之间的文本。
    const code = stripComments(file.text, modeForPath(file.path))
    const regions = options.logSinks === true ? logArgumentRegions(code) : []
    const lines = code.split('\n')
    let lineStart = 0
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? ''
      const start = lineStart
      lineStart += line.length + 1 // +1 = 换行符本身
      const text = line.trim()
      if (text === '') continue
      if (options.allowedLiterals?.some((pattern) => pattern.test(text)) === true) continue
      const offending = cjkColumns(line).some((column) => {
        const absolute = start + column
        return !regions.some(([from, to]) => absolute >= from && absolute < to)
      })
      if (offending) violations.push({ path: file.path, line: index + 1, text })
    }
  }
  return violations
}

/** 递归收集目录下的源文件，包含嵌套子目录。 */
export function collectSourceFiles(
  root: string,
  extensions: readonly string[],
  skip: (path: string) => boolean = () => false
): SourceFile[] {
  const found: SourceFile[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(full)
        continue
      }
      if (!extensions.some((extension) => entry.name.endsWith(extension))) continue
      const path = relative(process.cwd(), full).split(sep).join('/')
      if (skip(path)) continue
      found.push({ path, text: readFileSync(full, 'utf8') })
    }
  }
  visit(root)
  return found
}
