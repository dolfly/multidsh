/**
 * 发布验证的纯逻辑。
 *
 * This module is separate so tests can verify metadata field names, URL normalization,
 * and checksum comparison. Incorrect metadata can select the wrong update artifact.
 *
 * Do not add a YAML dependency: parse only the fixed electron-builder subset and reject unknown structures.
 */

export class UpdateMetadataError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UpdateMetadataError'
  }
}

/**
 * electron-builder 会把产物名里的空格换成连字符再写进更新元数据的 `url`
 * (磁盘上仍是 `DSH Hub-0.1.0-arm64-mac.zip`)。
 * 自动更新客户端按 URL 取文件,所以元数据里是连字符形态;
 * 而本地校验必须能把这两者对上,否则校验会假报「产物缺失」。
 */
export function normalizeArtifactUrl(url) {
  const decoded = safeDecode(url)
  const base = decoded.split('/').pop() ?? decoded
  return base.replace(/ /g, '-')
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function unquote(value) {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/**
 * 解析 electron-builder 的 `latest-mac.yml` / `latest.yml`。
 *
 * 只接受本应用实际产出的形态:
 *
 * ```yaml
 * version: 0.1.0
 * files:
 *   - url: DSH-Hub-0.1.0-arm64-mac.zip
 *     sha512: <base64>
 *     size: 120994809
 * path: DSH-Hub-0.1.0-arm64-mac.zip
 * sha512: <base64>
 * releaseDate: <ISO timestamp>
 * ```
 *
 * @returns {{version: string, files: Array<{url: string, sha512: string, size: number|null}>, path: string, sha512: string, releaseDate: string|null}}
 */
export function parseUpdateYaml(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new UpdateMetadataError('更新元数据为空')
  }
  const result = { version: '', files: [], path: '', sha512: '', releaseDate: null }
  let inFiles = false
  let current = null

  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.trim() === '' || rawLine.trimStart().startsWith('#')) continue
    const indent = rawLine.length - rawLine.trimStart().length
    const line = rawLine.trim()
    const colon = line.indexOf(':')
    if (colon === -1) throw new UpdateMetadataError(`无法解析的行：${line}`)
    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()

    if (indent === 0) {
      inFiles = false
      current = null
      if (key === 'files') {
        inFiles = true
      } else if (key === 'version') {
        result.version = unquote(value)
      } else if (key === 'path') {
        result.path = unquote(value)
      } else if (key === 'sha512') {
        result.sha512 = unquote(value)
      } else if (key === 'releaseDate') {
        result.releaseDate = unquote(value)
      }
      continue
    }

    if (!inFiles) continue
    if (line.startsWith('- ')) {
      current = { url: '', sha512: '', size: null }
      result.files.push(current)
      const entryKey = line.slice(2)
      const entryColon = entryKey.indexOf(':')
      if (entryColon === -1) throw new UpdateMetadataError(`无法解析的 files 条目：${line}`)
      assignFileField(
        current,
        entryKey.slice(0, entryColon).trim(),
        entryKey.slice(entryColon + 1).trim()
      )
      continue
    }
    if (!current) throw new UpdateMetadataError(`files 下的缩进字段缺少所属条目：${line}`)
    assignFileField(current, key, value)
  }

  if (!result.version) throw new UpdateMetadataError('更新元数据缺少 version')
  if (result.files.length === 0) throw new UpdateMetadataError('更新元数据缺少 files 条目')
  for (const entry of result.files) {
    if (!entry.url) throw new UpdateMetadataError('更新元数据存在缺少 url 的 files 条目')
    if (!entry.sha512) throw new UpdateMetadataError(`更新元数据 ${entry.url} 缺少 sha512`)
  }
  return result
}

function assignFileField(entry, key, value) {
  if (key === 'url') entry.url = unquote(value)
  else if (key === 'sha512') entry.sha512 = unquote(value)
  else if (key === 'size') {
    const size = Number(unquote(value))
    entry.size = Number.isFinite(size) ? size : null
  }
}

/**
 * 校验更新元数据与磁盘产物是否自洽。
 *
 * @param {object} input
 * @param {ReturnType<typeof parseUpdateYaml>} input.metadata
 * @param {string} input.appVersion
 * @param {Array<{name: string, sha512: string, size: number}>} input.artifacts 磁盘实测值
 * @returns {{ok: boolean, problems: string[]}}
 */
export function verifyUpdateMetadata({ metadata, appVersion, artifacts }) {
  const problems = []
  if (metadata.version !== appVersion) {
    problems.push(`版本不一致：元数据 ${metadata.version} ≠ package.json ${appVersion}`)
  }

  const byName = new Map()
  for (const artifact of artifacts) {
    byName.set(artifact.name, artifact)
    byName.set(normalizeArtifactUrl(artifact.name), artifact)
  }

  for (const entry of metadata.files) {
    const artifact = byName.get(entry.url) ?? byName.get(normalizeArtifactUrl(entry.url))
    if (!artifact) {
      problems.push(`元数据引用了不存在的产物：${entry.url}`)
      continue
    }
    if (artifact.sha512 !== entry.sha512) {
      problems.push(`sha512 不匹配：${entry.url}(元数据与实际字节不一致 → 更新包会被客户端拒绝)`)
    }
    if (entry.size !== null && entry.size !== artifact.size) {
      problems.push(`size 不匹配：${entry.url}（元数据 ${entry.size} ≠ 实际 ${artifact.size}）`)
    }
  }

  // 顶层 path/sha512 必须指向 files[0]：自动更新客户端优先读顶层字段
  const first = metadata.files[0]
  if (first) {
    if (normalizeArtifactUrl(metadata.path) !== normalizeArtifactUrl(first.url)) {
      problems.push(`顶层 path(${metadata.path}) 与 files[0].url(${first.url}) 不一致`)
    }
    if (metadata.sha512 !== first.sha512) {
      problems.push('顶层 sha512 与 files[0].sha512 不一致')
    }
  }
  return { ok: problems.length === 0, problems }
}

/**
 * 允许出现在公开 Release 的分发模式:
 * - `source-only`：tag、发布说明与 GitHub 自动生成的源码归档,不上传任何二进制资产。
 * - `windows-unsigned`：附带本地构建的未签名 Windows NSIS 安装包与其 SHA-256 校验清单
 *   (SmartScreen 会提示未知发布者);mac 二进制在未签名未公证前仍不随发布分发。
 */
export const DISTRIBUTION_MODES = ['source-only', 'windows-unsigned']

/** 任何模式都不得出现的资产形态(未签名 mac 二进制 / 自动更新元数据 / 差分中间产物) */
const ALWAYS_FORBIDDEN = [
  { pattern: /\.(dmg|app)$/i, reason: 'macOS 二进制在未签名未公证前不得公开分发' },
  { pattern: /\.zip$/i, reason: 'zip 归档不是当前声明的分发形态' },
  { pattern: /^latest(-.*)?\.ya?ml$/i, reason: '未签名安装包不随发布提供自动更新元数据' },
  { pattern: /\.blockmap$/i, reason: '差分包中间产物不属于分发给人的产物' }
]

/** windows-unsigned 允许的资产:NSIS 安装包(`DSH-Hub-Setup-<版本>.exe`)与 SHA-256 校验清单 */
const WINDOWS_INSTALLER = /^DSH-Hub-Setup-.*\.exe$/i
const WINDOWS_UNSIGNED_ALLOWED = [WINDOWS_INSTALLER, /^SHA256SUMS\.txt$/i]

/**
 * 校验「分发方式 ↔ 产物清单」是否自洽:
 * - 任何模式都拒绝未签名 mac 二进制、自动更新元数据与差分中间产物;
 * - `source-only` 一律无资产;
 * - `windows-unsigned` 只接受 Windows 安装包与 `SHA256SUMS.txt`,且必须含安装包。
 */
export function validateDistributionArtifacts(distribution, version, artifacts) {
  if (!DISTRIBUTION_MODES.includes(distribution)) {
    throw new UpdateMetadataError(`不支持的分发方式：${distribution}`)
  }
  for (const artifact of artifacts) {
    const forbidden = ALWAYS_FORBIDDEN.find((entry) => entry.pattern.test(artifact))
    if (forbidden) {
      throw new UpdateMetadataError(`发布说明不得声明资产 ${artifact}：${forbidden.reason}`)
    }
  }
  if (distribution === 'source-only') {
    if (artifacts.length > 0) {
      throw new UpdateMetadataError(
        'source-only 发布说明不得声明桌面安装包、更新元数据或校验和资产'
      )
    }
    return
  }
  // windows-unsigned
  for (const artifact of artifacts) {
    if (!WINDOWS_UNSIGNED_ALLOWED.some((pattern) => pattern.test(artifact))) {
      throw new UpdateMetadataError(
        `windows-unsigned 发布说明只允许 Windows 安装包与 SHA256SUMS.txt，但声明了 ${artifact}`
      )
    }
  }
  if (!artifacts.some((artifact) => WINDOWS_INSTALLER.test(artifact))) {
    throw new UpdateMetadataError(
      'windows-unsigned 发布说明必须声明 Windows 安装包（DSH-Hub-Setup-<版本>.exe）'
    )
  }
}

/**
 * 从发布说明里抽出机器可校验的发布字段。
 * 只接受 `DISTRIBUTION_MODES` 中显式声明的模式,避免把未签名桌面包误当作官方资产。
 *
 * @returns {{version: string, date: string, distribution: 'source-only'|'windows-unsigned', artifacts: string[]}}
 */
export function parseReleaseNotes(markdown) {
  if (typeof markdown !== 'string' || markdown.trim() === '') {
    throw new UpdateMetadataError('发布说明为空')
  }
  const headingMatch = /^#\s+.*?v(\d+\.\d+\.\d+[^\s]*)\s*$/m.exec(markdown)
  if (!headingMatch) throw new UpdateMetadataError('发布说明缺少形如「# DSH Hub v1.2.3」的一级标题')
  const dateMatch = /^-\s*发布日期[:：]\s*(\d{4}-\d{2}-\d{2})\s*$/m.exec(markdown)
  if (!dateMatch) throw new UpdateMetadataError('发布说明缺少「- 发布日期: YYYY-MM-DD」行')

  const lines = markdown.split(/\r?\n/)
  const distributionStart = lines.findIndex((line) => /^##\s+分发方式\s*$/.test(line))
  if (distributionStart === -1) throw new UpdateMetadataError('发布说明缺少「## 分发方式」小节')
  const distributionLines = []
  for (let i = distributionStart + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^##\s/.test(line)) break
    distributionLines.push(line)
  }
  const modes = distributionLines
    .map((line) => /^-\s*`([^`]+)`\s*$/.exec(line))
    .filter((match) => match !== null)
    .map((match) => match[1])
  if (modes.length !== 1 || !DISTRIBUTION_MODES.includes(modes[0])) {
    throw new UpdateMetadataError(
      `分发方式必须明确且只能是 ${DISTRIBUTION_MODES.map((mode) => `\`${mode}\``).join(' 或 ')}`
    )
  }
  const distribution = modes[0]

  const artifactsStart = lines.findIndex((line) => /^##\s+产物\s*$/.test(line))
  const section = []
  if (artifactsStart !== -1) {
    for (let i = artifactsStart + 1; i < lines.length; i++) {
      const line = lines[i]
      if (/^##\s/.test(line)) break
      section.push(line)
    }
  }
  const artifacts = section
    .map((line) => /^-\s*`([^`]+)`/.exec(line))
    .filter((match) => match !== null)
    .map((match) => match[1])
  validateDistributionArtifacts(distribution, headingMatch[1], artifacts)
  return { version: headingMatch[1], date: dateMatch[1], distribution, artifacts }
}

/** 发布说明里不允许残留的占位符 */
export const PLACEHOLDER_MARKERS = ['TODO', 'TBD', '待填', 'XXX', '<填', '{{']

export function findPlaceholders(markdown) {
  return PLACEHOLDER_MARKERS.filter((marker) => markdown.includes(marker))
}
