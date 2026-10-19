// 不写 hashbang：本文件被单测静态导入，而 CRLF 检出（Windows 无 .gitattributes）下
// vite SSR 变换会把 #! 挤到文件中部，模块求值报 SyntaxError；脚本经 node/pnpm 显式调用即可。
/**
 * 半自动发布：推 tag → 建/更新 Draft → 上传资产 → 白名单核验 →（`--publish`）发布。
 *
 * 本脚本**不负责构建**（构建依赖本机环境，仍按 docs/release-runbook.md §3 人工执行），
 * 也不属于流水线：由人显式发起，每一步幂等（已存在则跳过或更新），可随时中断重跑。
 *
 * 用法：`node scripts/release/publish.mjs [--dry-run] [--publish]`
 * - 默认停在 Draft：核验通过后退出，由人在 GitHub 网页确认后再发布；
 * - `--publish`：核验后执行 `PATCH draft=false make_latest=true`（不带 make_latest 会丢 Latest 徽标）；
 * - `--dry-run`：本地校验与远端查询照常执行，所有变更动作只打印不执行。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sha256Of } from './checksums.mjs'
import { findPlaceholders, parseReleaseNotes } from './lib.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..')
const SUMS_FILE = 'SHA256SUMS.txt'

export class PublishError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PublishError'
  }
}

/** 按分发方式给出「必须出现在 Release 上」的精确资产集合（源码归档由 GitHub 自动生成，不在 assets 里）。 */
export function expectedAssets(distribution, version) {
  if (distribution === 'source-only') return []
  if (distribution === 'windows-unsigned') {
    return [`DSH-Hub-Setup-${version}.exe`, SUMS_FILE]
  }
  throw new PublishError(`不支持的分发方式：${distribution}`)
}

/** 解析 `sha256␠␠文件名` 清单为 Map；形态不对的行直接拒绝（清单被篡改/写错无法察觉比缺失更危险）。 */
export function parseSums(text) {
  const entries = new Map()
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.trim() === '') continue
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(rawLine)
    if (!match) throw new PublishError(`SHA256SUMS.txt 含无法解析的行：${rawLine}`)
    if (entries.has(match[2])) throw new PublishError(`SHA256SUMS.txt 重复条目：${match[2]}`)
    entries.set(match[2], match[1])
  }
  if (entries.size === 0) throw new PublishError('SHA256SUMS.txt 为空')
  return entries
}

/** 本地资产校验：文件齐全 + 安装包实测 sha256 与清单一致。source-only 无需任何资产。 */
export async function verifyLocalAssets({ root = ROOT, version, distribution }) {
  if (distribution === 'source-only') return []
  const installer = `DSH-Hub-Setup-${version}.exe`
  const dir = join(root, 'dist', 'upload')
  const installerPath = join(dir, installer)
  const sumsPath = join(dir, SUMS_FILE)
  if (!existsSync(installerPath)) {
    throw new PublishError(
      `${installerPath} 不存在 —— 先构建：pnpm dist:win:local 并拷贝到 dist/upload/（runbook §3）`
    )
  }
  if (!existsSync(sumsPath)) {
    throw new PublishError(
      `${sumsPath} 不存在 —— 先生成：node scripts/release/checksums.mjs dist/upload`
    )
  }
  const sums = parseSums(readFileSync(sumsPath, 'utf8'))
  const expected = sums.get(installer)
  if (expected === undefined) {
    throw new PublishError(`SHA256SUMS.txt 没有 ${installer} 的条目（清单与产物对不上，重新生成）`)
  }
  const actual = await sha256Of(installerPath)
  if (actual !== expected) {
    throw new PublishError(
      `${installer} 实测 sha256 与清单不一致（产物与清单至少有一者过期，重新生成清单）`
    )
  }
  return [installerPath, sumsPath]
}

/**
 * 本地 tag 决策：缺失则建在 HEAD；已存在必须正指 HEAD（同版本重发按 runbook §6 先作废）。
 * @returns {'create'|'keep'}
 */
export function decideLocalTag({ hasLocalTag, tagSha, headSha }) {
  if (!hasLocalTag) return 'create'
  if (tagSha !== headSha) {
    throw new PublishError(
      `tag 已存在但指向 ${tagSha}，HEAD 是 ${headSha} —— 同版本重发先按 runbook §6 作废旧 tag`
    )
  }
  return 'keep'
}

/**
 * 远端 tag 推送决策：远端缺失则推送；已存在必须与本地一致（否则说明有人动过远端 tag）。
 * @returns {'push'|'skip'}
 */
export function decideRemotePush({ remoteSha, localSha }) {
  if (remoteSha === null) return 'push'
  if (remoteSha !== localSha) {
    throw new PublishError(
      `远端 tag 与本地不一致（远端 ${remoteSha}，本地 ${localSha}）—— 按 runbook §6 人工处置后再跑`
    )
  }
  return 'skip'
}

/**
 * Release 状态决策：不存在则建 draft；已是 draft 则更新（说明/资产幂等覆盖）；
 * 已发布的一律拒绝（发布后纠错发 patch 版本，不删 Release 重发同版本）。
 * @returns {'create'|'update'}
 */
export function decideDraft(release, tag) {
  if (release === null) return 'create'
  if (release.draft) return 'update'
  throw new PublishError(
    `Release ${tag} 已发布 —— 已发布的 Release 不删不重发（runbook §6），要改就发 patch 版本`
  )
}

/** 远端资产白名单核验：必须与分发方式声明的集合**完全一致**（多传少传都拒绝）。 */
export function verifyRemoteAssets(distribution, version, names) {
  const expected = expectedAssets(distribution, version).slice().sort()
  const actual = [...names].slice().sort()
  const missing = expected.filter((name) => !actual.includes(name))
  const extra = actual.filter((name) => !expected.includes(name))
  if (missing.length > 0 || extra.length > 0) {
    const parts = []
    if (missing.length > 0) parts.push(`缺少 ${missing.join(', ')}`)
    if (extra.length > 0)
      parts.push(`多出 ${extra.join(', ')}（禁止上传：mac 产物 / latest-*.yml / .blockmap）`)
    throw new PublishError(`Release 资产与 ${distribution} 声明不一致：${parts.join('；')}`)
  }
  return actual
}

// ---------- 远端操作（gh / git），与决策逻辑分离 ----------

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: options.capture === true ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'inherit'],
    ...options
  })
    .toString()
    .trim()
}

function gh(args) {
  return execFileSync('gh', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
    .toString()
    .trim()
}

function remoteTagSha(tag) {
  let out
  try {
    out = git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`])
  } catch {
    throw new PublishError('git ls-remote origin 失败 —— 确认 origin 可达（网络/代理）后重跑')
  }
  if (out === '') return null
  for (const line of out.split('\n')) {
    const [sha, name] = line.split('\t')
    if (name === undefined) continue
    if (name.endsWith('^{}')) return sha // annotated tag 的 peel 结果 = commit sha
  }
  return out.split('\n')[0].split('\t')[0] // lightweight tag
}

/** 查询 Release（读操作）：不存在返回 null；gh 其它错误原样抛出。 */
function fetchRelease(repo, tag) {
  try {
    const body = gh(['api', `repos/${repo}/releases/tags/${tag}`])
    const data = JSON.parse(body)
    return { id: data.id, draft: data.draft, assets: (data.assets ?? []).map((a) => a.name) }
  } catch (error) {
    const stderr = error?.stderr !== undefined ? String(error.stderr) : ''
    if (stderr.includes('Not Found') || stderr.includes('404')) return null
    throw new PublishError(`查询 Release ${tag} 失败：${stderr.trim() || error.message}`)
  }
}

function makeRunner({ dryRun, log }) {
  return function run(label, command, args) {
    const rendered = `${command} ${args.join(' ')}`
    if (dryRun) {
      log(`DRY   ${label}：${rendered}`)
      return ''
    }
    log(`${label}：${rendered}`)
    return execFileSync(command, args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit']
    })
      .toString()
      .trim()
  }
}

async function main(argv) {
  const dryRun = argv.includes('--dry-run')
  const doPublish = argv.includes('--publish')
  const unknown = argv.filter((flag) => flag !== '--dry-run' && flag !== '--publish')
  if (unknown.length > 0) throw new PublishError(`未知参数：${unknown.join(' ')}`)

  const log = (message) => console.log(`[publish] ${message}`)
  const run = makeRunner({ dryRun, log })

  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const version = String(pkg.version)
  const tag = `v${version}`
  const notesPath = join(ROOT, 'docs', 'releases', `${tag}.md`)
  log(`=== 半自动发布 ${tag}（${dryRun ? 'dry-run，不执行变更' : '执行'}）===`)

  // 1) 发布说明：版本一致、可解析、无占位符（publish 不依赖 release:check 先跑过）
  if (!existsSync(notesPath)) throw new PublishError(`发布说明缺失：docs/releases/${tag}.md`)
  const notes = parseReleaseNotes(readFileSync(notesPath, 'utf8'))
  if (notes.version !== version) {
    throw new PublishError(`发布说明写的是 v${notes.version}，package.json 是 v${version}`)
  }
  const placeholders = findPlaceholders(readFileSync(notesPath, 'utf8'))
  if (placeholders.length > 0)
    throw new PublishError(`发布说明残留占位符：${placeholders.join(' / ')}`)
  log(`1/6 发布说明 OK（${notes.distribution}，${notes.artifacts.length} 项资产声明）`)

  // 2) 本地资产（构建由人工完成，脚本只校验）
  const uploadFiles = await verifyLocalAssets({ version, distribution: notes.distribution })
  log(`2/6 本地资产 OK（${uploadFiles.length} 个文件就绪）`)

  // 3) 前置：main、工作树、远端同步（runbook §4 的人工确认项）
  const branch = git(['branch', '--show-current'])
  if (branch !== 'main') throw new PublishError(`当前分支是 ${branch}，必须在 main 上发布`)
  if (git(['status', '--porcelain']) !== '')
    throw new PublishError('工作树不干净 —— 先提交或暂存（runbook §4）')
  const headSha = git(['rev-parse', 'HEAD'])
  let remoteMain
  try {
    remoteMain = git(['ls-remote', '--heads', 'origin', 'refs/heads/main'])
  } catch {
    throw new PublishError('查询 origin/main 失败 —— 确认网络/代理后重跑')
  }
  const remoteMainSha = remoteMain.split('\t')[0] || ''
  if (remoteMainSha !== headSha) {
    throw new PublishError(
      remoteMainSha === ''
        ? 'origin/main 不存在 —— 先 git push origin main（runbook §4）'
        : `本地 main(${headSha.slice(0, 7)}) 与 origin/main(${remoteMainSha.slice(0, 7)}) 不同步 —— 先 git push origin main（runbook §4）`
    )
  }
  log(`3/6 前置 OK（main @ ${headSha.slice(0, 7)}，工作树干净，远端已同步）`)

  // 4) tag：本地缺失则建，远端缺失则推；一致则跳过
  let localTagSha
  try {
    localTagSha = git(['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], { capture: true })
  } catch {
    localTagSha = null
  }
  const localAction = decideLocalTag({
    hasLocalTag: localTagSha !== null,
    tagSha: localTagSha,
    headSha
  })
  if (localAction === 'create') {
    run(`建本地 tag ${tag}`, 'git', ['tag', '-a', tag, '-m', `DSH Hub ${version}`])
    if (!dryRun) localTagSha = git(['rev-parse', `refs/tags/${tag}^{commit}`], { capture: true })
    else localTagSha = headSha
  } else {
    log(`4/6 本地 tag ${tag} 已在 HEAD，跳过`)
  }
  const remoteSha = remoteTagSha(tag)
  const pushAction = decideRemotePush({ remoteSha, localSha: localTagSha })
  if (pushAction === 'push') run(`推送 tag ${tag}`, 'git', ['push', 'origin', `refs/tags/${tag}`])
  else log(`远端 tag ${tag} 已一致，跳过`)
  log(`4/6 tag OK`)

  // 5) Draft：create / update，资产幂等上传，白名单核验
  const repo = gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
  const existing = fetchRelease(repo, tag)
  const draftAction = decideDraft(existing, tag)
  const notesArg = join('docs', 'releases', `${tag}.md`)
  if (draftAction === 'create') {
    const args = [
      'release',
      'create',
      tag,
      '--draft',
      '--title',
      `DSH Hub ${version}`,
      '--notes-file',
      notesArg
    ]
    if (notes.distribution === 'windows-unsigned')
      args.push(...uploadFiles.map((f) => join(ROOT, f)))
    run('创建 Draft', 'gh', args)
  } else {
    run('更新 Draft 说明', 'gh', [
      'release',
      'edit',
      tag,
      '--draft',
      '--title',
      `DSH Hub ${version}`,
      '--notes-file',
      notesArg
    ])
    if (uploadFiles.length > 0) {
      run('覆盖上传资产', 'gh', [
        'release',
        'upload',
        tag,
        ...uploadFiles.map((f) => join(ROOT, f)),
        '--clobber'
      ])
    }
  }
  const release = fetchRelease(repo, tag)
  if (dryRun && release === null) {
    log('5/6 (dry-run) Draft 将创建，远端资产核验待真实执行时进行')
  } else {
    const remoteNames = release === null ? [] : release.assets
    verifyRemoteAssets(notes.distribution, version, remoteNames)
    log(
      `5/6 Draft 资产白名单核验 OK（${remoteNames.length} 个资产：${remoteNames.join(', ') || '无'}）`
    )
  }

  // 6) 发布：默认停在 Draft；--publish 才 PATCH
  if (!doPublish) {
    log(
      '6/6 停在 Draft（默认）—— 网页确认后执行 pnpm release:publish -- --publish，或直接在网页 Publish'
    )
    return
  }
  const current = fetchRelease(repo, tag)
  if (current === null && dryRun) {
    log('6/6 (dry-run) Release 尚未创建，PATCH 发布与 Latest 核验待真实执行时进行')
    return
  }
  if (current === null || !current.draft)
    throw new PublishError('发布前复查失败：Release 不存在或已是发布态')
  run('发布并置为 Latest', 'gh', [
    'api',
    '-X',
    'PATCH',
    `repos/${repo}/releases/${current.id}`,
    '-F',
    'draft=false',
    '-F',
    'make_latest=true'
  ])
  if (dryRun) {
    log('6/6 (dry-run) 发布与 Latest 核验待真实执行时进行')
    return
  }
  const latest = JSON.parse(gh(['api', `repos/${repo}/releases/latest`]))
  if (latest.tag_name !== tag) {
    throw new PublishError(
      `已发布但 Latest 指向 ${latest.tag_name} 而非 ${tag} —— 立即在网页修正徽标`
    )
  }
  log(`6/6 已发布并确认 Latest = ${tag}`)
}

// Windows 下 argv[1] 是反斜杠盘符路径，必须经 pathToFileURL 归一后才能与 import.meta.url 比较
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[publish] 失败：${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
