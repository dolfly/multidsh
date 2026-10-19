#!/usr/bin/env node
/**
 * 发布演练。
 *
 * 公开发布的分发模式由发布说明的「分发方式」小节声明（见 `docs/release-policy.md`）：
 * - `source-only`：只发布 tag、发布说明与 GitHub 自动生成的源码归档，不上传任何二进制资产。
 * - `windows-unsigned`：附带本地构建的未签名 Windows 安装包与 `SHA256SUMS.txt`。
 * 脚本只做离线校验；构建仍人工完成，推 tag、创建 Draft、上传资产与发布由
 * `pnpm release:publish`（scripts/release/publish.mjs）半自动执行——人工发起，非流水线。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { findPlaceholders, parseReleaseNotes } from './lib.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..')
/** @type {Array<{name: string, status: 'PASS'|'SKIP'|'FAIL', message?: string}>} */
const results = []

async function check(name, fn) {
  try {
    await fn()
    results.push({ name, status: 'PASS' })
    console.log(`PASS  ${name}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    results.push({ name, status: 'FAIL', message })
    console.log(`FAIL  ${name}\n      ${message}`)
  }
}

function skip(name, why) {
  results.push({ name, status: 'SKIP', message: why })
  console.log(`SKIP  ${name}\n      ${why}`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function readText(relative) {
  return readFileSync(join(ROOT, relative), 'utf8')
}

function git(args) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim()
}

const pkg = JSON.parse(readText('package.json'))
const version = String(pkg.version)
const tag = `v${version}`
const builderYml = readText('electron-builder.yml')
const releaseNotesPath = `docs/releases/${tag}.md`

console.log(`\n=== DSH Hub 发布演练（版本 ${version}，标签 ${tag}）===\n`)

let notes = null
await check('版本号是合法 semver', () => {
  assert(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version),
    `package.json version="${version}" 不是合法 semver`
  )
})

await check(`发布说明 ${releaseNotesPath} 可解析`, () => {
  notes = parseReleaseNotes(readText(releaseNotesPath))
})

if (notes) {
  await check('发布说明版本与 package.json 一致', () => {
    assert(
      notes.version === version,
      `发布说明写的是 v${notes.version}，package.json 是 v${version}`
    )
  })
  await check('发布说明日期格式正确', () => {
    assert(/^\d{4}-\d{2}-\d{2}$/.test(notes.date), `发布日期 "${notes.date}" 不是 YYYY-MM-DD`)
  })
  await check('发布说明的分发方式与资产清单自洽', () => {
    assert(
      notes.distribution === 'source-only' || notes.distribution === 'windows-unsigned',
      `未知分发方式：${notes.distribution}`
    )
    if (notes.distribution === 'source-only') {
      assert(
        notes.artifacts.length === 0,
        `source-only 发布说明声明了资产：${notes.artifacts.join(', ')}`
      )
    } else {
      // windows-unsigned：安装包名必须与当前版本一致（parseReleaseNotes 已校验形态白名单）
      const installer = `DSH-Hub-Setup-${version}.exe`
      assert(
        notes.artifacts.includes(installer),
        `windows-unsigned 发布说明须声明安装包 ${installer}，实际：${notes.artifacts.join(', ') || '（无）'}`
      )
    }
  })
  await check('发布说明不含占位符', () => {
    const found = findPlaceholders(readText(releaseNotesPath))
    assert(found.length === 0, `发布说明残留占位符：${found.join(' / ')}`)
  })
}

await check('electron-builder 不配置 GitHub publish provider', () => {
  assert(!/^publish:\s*$/m.test(builderYml), 'electron-builder.yml 不得配置 publish')
  assert(
    !/^\s*provider:\s*github\s*$/m.test(builderYml),
    'electron-builder.yml 不得配置 GitHub provider'
  )
})

await check('本地打包脚本一律 --publish never', () => {
  for (const name of ['dist', 'dist:mac', 'dist:mac:zip', 'dist:win']) {
    const script = pkg.scripts[name]
    assert(typeof script === 'string', `package.json 缺少脚本 ${name}`)
    assert(script.includes('--publish never'), `脚本 ${name} 未带 --publish never：${script}`)
  }
})

await check('零运行时依赖', () => {
  const deps = pkg.dependencies ?? {}
  assert(Object.keys(deps).length === 0, `运行时依赖不为空：${Object.keys(deps).join(', ')}`)
})

// 发布文档引用的本地路径必须真实存在：docs/local/ 从未入库（gitignore），
// 引用它等于给读者一条必然 404 的命令。只扫现行文档；历史 Release 正文是已发布事实，
// 不回头改写（见 docs/release-runbook.md）。
await check('发布文档引用的本地路径存在', () => {
  const livingDocs = ['docs/release-policy.md', 'docs/release-runbook.md', releaseNotesPath]
  const missing = []
  for (const doc of livingDocs) {
    if (!existsSync(join(ROOT, doc))) {
      missing.push(`${doc}（文档自身缺失）`)
      continue
    }
    const text = readText(doc)
    for (const match of text.matchAll(/(?:docs|scripts|tests)\/[\w./-]+/g)) {
      const ref = match[0].replace(/[.,;:)\]]+$/, '')
      // 跳过模板占位（如 docs/releases/v<version>.md：[\w] 在 `<` 处截断，
      // 看匹配后一位是否紧接占位/通配符）与行内通配写法。
      const after = text[match.index + match[0].length] ?? ''
      if (/[<>*]/.test(ref) || /[<>*]/.test(after)) continue
      if (!existsSync(join(ROOT, ref))) missing.push(`${doc} → ${ref}`)
    }
  }
  assert(missing.length === 0, `引用了不存在的路径：${missing.join('；')}`)
})

let headTag = null
try {
  headTag = git(['describe', '--tags', '--exact-match'])
} catch {
  headTag = null
}
if (headTag === null) {
  skip(`HEAD 处于 ${tag} 标签上`, '当前提交没有精确匹配的 tag（发布时才打标签，属预期）')
} else {
  await check(`HEAD 标签等于 ${tag}`, () => {
    assert(headTag === tag, `HEAD 上的 tag 是 ${headTag}，与 package.json 版本的 ${tag} 不一致`)
  })
}

let remoteUrl = null
try {
  remoteUrl = git(['remote', 'get-url', 'origin'])
} catch {
  remoteUrl = null
}
if (remoteUrl === null || remoteUrl === '') {
  skip(
    '远端 tag 推送演练',
    '本仓库没有 origin remote（纯本地仓库）—— 创建 GitHub 仓库后再执行下方命令'
  )
} else {
  await check('origin remote 已配置', () => {
    assert(remoteUrl.length > 0, 'origin remote 为空')
  })
}

const failed = results.filter((item) => item.status === 'FAIL')
const skipped = results.filter((item) => item.status === 'SKIP')
const passed = results.length - failed.length - skipped.length
console.log(`\n=== 汇总：PASS ${passed} / SKIP ${skipped.length} / FAIL ${failed.length} ===`)

const distribution = notes?.distribution ?? 'source-only'
if (distribution === 'windows-unsigned') {
  console.log(`\n--- 收口步骤（windows-unsigned）---`)
  console.log('  1) 构建未签名 Windows 安装包并生成校验清单（人工，脚本不代做）：')
  console.log(
    '       pnpm dist:win:local   # mac 交叉构建（electron-builder 自行下载 Windows 版 Electron）；或在 Windows 上 pnpm dist:win'
  )
  console.log(`       mkdir -p dist/upload && cp dist/DSH-Hub-Setup-${version}.exe dist/upload/`)
  console.log(
    '       node scripts/release/checksums.mjs dist/upload   # 生成 dist/upload/SHA256SUMS.txt'
  )
  console.log('  2) pnpm release:publish')
  console.log('       # 推 tag、建 Draft、上传资产、白名单核验（幂等，停在 Draft）')
  console.log('  3) 在 GitHub 上确认 Draft Release 只含上述两个资产与源码归档，然后：')
  console.log('       pnpm release:publish -- --publish   # 或直接在网页点 Publish release')
  console.log(
    '\n  只上传 Windows 安装包与 SHA256SUMS.txt：未签名安装包会触发 SmartScreen「未知发布者」提示；'
  )
  console.log(
    '  不上传 mac 二进制、latest-*.yml 或 .blockmap（mac 二进制须先完成签名与公证，见 docs/release-policy.md）。'
  )
} else {
  console.log(`\n--- 收口步骤（source-only）---`)
  console.log('  1) pnpm release:publish')
  console.log('       # 推 tag、建 Draft（幂等，停在 Draft）')
  console.log(
    '  2) 在 GitHub 上确认 Draft Release 只保留 Release Note 与自动生成的源码归档，然后：'
  )
  console.log('       pnpm release:publish -- --publish   # 或直接在网页点 Publish release')
  console.log(
    '\n  不上传任何二进制资产：.exe、.app、.dmg、.zip、SHA256SUMS.txt、latest-*.yml 一律不上传。'
  )
  console.log(
    '  本地打包仅用于开发、本机验证和受控测试；恢复 mac 二进制发行前须满足 docs/release-policy.md 的签名与公证条件。'
  )
}

if (failed.length > 0) {
  console.log('\n发布演练失败：')
  for (const item of failed) console.log(`  · ${item.name}：${item.message}`)
  process.exit(1)
}
console.log(`\n发布演练通过（${distribution} 离线校验部分全绿）。`)
