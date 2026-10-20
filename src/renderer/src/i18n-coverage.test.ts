import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MESSAGES, MESSAGE_KEYS } from '@shared/i18n/messages'

/**
 * i18n 覆盖检查。
 *
 * - 扫描整个 `src/` 树中的 `.ts`、`.tsx`、`.css` 与 `.html` 文件；文案目录是唯一排除项。
 * - 按行检查硬编码中日韩文案，保留字符串、模板、正则和 JSX/HTML 文本节点，并保持原始行号。
 * - 识别字面字符和 Unicode 转义；语言选择器、日志实参和已登记的非渲染层文案按规则处理。
 * - 扫描核心接受 `{ path, text }[]`，以便用合成源码验证边界情况。
 * - 非渲染层文案分为用户可见和内部诊断两类，清单必须与扫描结果一致。
 */

import {
  collectSourceFiles,
  logArgumentRegions,
  modeForPath,
  scanSources,
  type SourceFile,
  type Violation
} from './i18n-scan.testkit'

// ───────────────────────── 规则数据 ─────────────────────────

const SRC_ROOT = join(process.cwd(), 'src')
const RENDERER_PREFIX = 'src/renderer/'
const RENDERER_ROOT = join(SRC_ROOT, 'renderer')
const RENDERER_SRC = join(RENDERER_ROOT, 'src')
const COMPONENTS_DIR = join(RENDERER_SRC, 'components')
/** 全树的扩展名表:`.css`(伪元素文案)与 `.html`(`<title>` 直接上屏)同样算界面文案 */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.css', '.html'] as const

/**
 * 允许保留的字面量:语言选择器按惯例用**该语言自身**书写（「中文」/English），
 * 翻译它反而会让用户找不到自己的语言。逐行精确匹配，只作用于这一行。
 */
const ALLOWED_LITERALS: readonly RegExp[] = [/^\{?language === 'zh' \? '中文' : 'English'\}?$/]

/**
 * 扫描时唯一排除文案目录本身，避免把文案定义视为待迁移的硬编码文案。
 */
const SOURCE_EXCLUSIONS: readonly string[] = ['src/shared/i18n/messages.ts']

/** SOURCE_EXCLUSIONS 的独立字面量副本。 */
const SOURCE_EXCLUSIONS_PIN: readonly string[] = ['src/shared/i18n/messages.ts']

const isExcluded = (path: string): boolean => SOURCE_EXCLUSIONS.includes(path)

/** 测试文件与 testkit 不参与判定:里面的中文是测试名、fixture 与断言数据,不是界面文案,也不进打包产物 */
const isTestFile = (path: string): boolean => /\.test(?:kit)?\.tsx?$/.test(path)

/** 整树收集（`src/**`,递归,含渲染层 `index.html` 与 `src/shared`/`src/preload`） */
function collectScannedFiles(): SourceFile[] {
  return collectSourceFiles(
    SRC_ROOT,
    SOURCE_EXTENSIONS,
    (path) => isTestFile(path) || isExcluded(path)
  )
}

const isRendererPath = (path: string): boolean => path.startsWith(RENDERER_PREFIX)

/**
 * 非渲染层(主进程 + shared + preload)显式豁免表。每条都必须写清「为什么它不可能是用户可见文案」——
 * 这是非渲染层唯一被允许的“规则型”出口，不允许再出现别的整体豁免（禁止 blanket-exempt）。
 */
const NON_RENDERER_EXEMPTIONS = [
  {
    id: 'process-log',
    kind: 'console-args',
    levels: ['log', 'info', 'warn', 'error', 'debug', 'trace'],
    // 为什么不是用户可见文案:console.* 的实参只写进 Electron 主进程的 stdout/stderr
    // （终端 / 日志文件），不经过任何 IPC 通道，渲染层也拿不到 —— 界面上永远看不到。
    // 只豁免**实参区间内**的文案:同一行里若还有别的中文字面量（比如拼给 IPC 信封的 message），
    // 仍然判违规。
    reason: '主进程日志:只进终端/日志文件，不进入任何 UI 通道'
  }
] as const

const LOG_SINK_ENABLED = NON_RENDERER_EXEMPTIONS.some((entry) => entry.kind === 'console-args')

/**
 * 已迁移文案的渲染层文件，相对 `src/renderer/src`。
 * 清单与独立副本保持一致，防止意外缩小检查范围。
 */
const MIGRATED = [
  '../App.tsx',
  '../store.ts',
  'Sidebar.tsx',
  'SettingsView.tsx',
  'AuthPanel.tsx',
  'VaultCard.tsx',
  'EmptyView.tsx',
  'Toasts.tsx',
  'Modal.tsx',
  'UrlDetect.tsx',
  'KeyPreview.tsx',
  'HomeView.tsx',
  'SshDialogs.tsx',
  'DetailView.tsx',
  'Wizard.tsx'
]

/** MIGRATED 的独立字面量副本，用于验证清单完整性。 */
const MIGRATED_PIN: readonly string[] = [
  '../App.tsx',
  '../store.ts',
  'Sidebar.tsx',
  'SettingsView.tsx',
  'AuthPanel.tsx',
  'VaultCard.tsx',
  'EmptyView.tsx',
  'Toasts.tsx',
  'Modal.tsx',
  'UrlDetect.tsx',
  'KeyPreview.tsx',
  'HomeView.tsx',
  'SshDialogs.tsx',
  'DetailView.tsx',
  'Wizard.tsx'
]

/** 暂缓检查的渲染层文件，路径与 Violation.path 一致。 */
const PENDING: readonly string[] = []

/** PENDING 的独立字面量副本。 */
const PENDING_PIN: readonly string[] = []

const isPending = (path: string): boolean => PENDING.includes(path)

/** 债务站点由文件路径和行文本标识；行号不参与标识，避免无关换行造成清单失效。 */
type DebtEntry = readonly [file: string, text: string]

/** 构造一条债务条目(只是让清单可读:比裸元组少一层括号噪音) */
const debt = (file: string, text: string): DebtEntry => [file, text]

/** 站点键:路径与文案之间用 `\u0000` 分隔(源码文本里不可能出现,不会撞键) */
const siteKey = (path: string, text: string): string => `${path}\u0000${text}`

/** 把站点键还原成可读形式,只用于失败信息 */
const readableSite = (key: string): string => key.replace('\u0000', ' :: ')

/**
 * 非渲染层硬编码文案按用户可见和内部诊断分类。
 * 用户可见项通过 IPC、状态、认证或探测字段进入界面；内部项不经过 UI。
 * 两类清单的并集必须与扫描到的站点一致。
 */
const NON_RENDERER_COPY_DEBT_USER_VISIBLE: readonly DebtEntry[] = [
  // —— IPC 信封 message（渲染层 toast 直接展示 result.message） ——
  debt(
    'src/main/ipc/instance-handlers.ts',
    ".refine((v) => v === null || v.trim() !== '', '口令不能为空串')"
  ),
  debt(
    'src/main/registry/instance-store.ts',
    "return new InstanceStoreError('not-found', `实例不存在：${id}`)"
  ),
  debt(
    'src/main/ipc/settings-handlers.ts',
    "if (!deps.openDataDir) throw new DataDirOpenError('internal', '打开数据目录不可用')"
  ),
  debt(
    'src/main/ipc/register.ts',
    "if (!deps.openHomepage) throw new HomepageOpenError('internal', '打开项目主页不可用')"
  ),
  debt(
    'src/main/ipc/register.ts',
    "if (!deps.openAbout) throw new HomepageOpenError('internal', '打开关于面板不可用')"
  ),
  debt(
    'src/main/shell/open-data-dir.ts',
    "if (dir === '') throw new DataDirOpenError('internal', '数据目录不可用')"
  ),
  debt(
    'src/main/registry/instance-store.ts',
    "return new InstanceStoreError('io-error', `注册表 IO 失败：${message}`)"
  ),
  debt('src/main/ipc/ipc-utils.ts', "return fail('internal', '内部错误，请查看应用日志')"),
  debt(
    'src/main/ipc/instance-handlers.ts',
    "throw new InstanceStoreError('invalid-input', '只有 SSH 隧道实例才有主机指纹')"
  ),
  debt(
    'src/main/ipc/instance-handlers.ts',
    "throw new InstanceStoreError('invalid-state', '本机隔离空间管理不可用')"
  ),
  debt(
    'src/main/ipc/instance-handlers.ts',
    "if (!space) throw new InstanceStoreError('not-found', '找不到该本机隔离空间')"
  ),
  debt(
    'src/main/ipc/instance-handlers.ts',
    "throw new InstanceStoreError('invalid-state', '该隔离空间正被实例占用，无法删除')"
  ),
  debt(
    'src/main/ipc/instance-handlers.ts',
    "throw new InstanceStoreError('invalid-input', '仅本机实例有本地目录')"
  ),
  debt(
    'src/main/ipc/instance-handlers.ts',
    "throw new InstanceStoreError('invalid-state', '打开实例目录不可用')"
  ),
  debt(
    'src/main/ipc/instance-handlers.ts',
    "throw new InstanceStoreError('invalid-state', '打开日志目录不可用')"
  ),
  debt(
    'src/main/ipc/runtime-handlers.ts',
    "throw new InstanceStoreError('invalid-input', '未知的传输类型')"
  ),
  debt(
    'src/main/ipc/runtime-handlers.ts',
    "throw new InstanceStoreError('invalid-state', '实例未在运行，无法在浏览器中打开')"
  ),
  debt(
    'src/main/ipc/runtime-handlers.ts',
    "throw new InstanceStoreError('invalid-input', '只有本机实例和远程实例支持在浏览器中打开')"
  ),
  debt(
    'src/main/ipc/runtime-handlers.ts',
    "throw new InstanceStoreError('internal', '在浏览器中打开不可用')"
  ),
  debt('src/main/registry/instance-store.ts', '`字段 ${key} 不适用于 ${current.transport} 实例`'),
  debt(
    'src/main/registry/instance-store.ts',
    "throw new InstanceStoreError('invalid-input', '排序列表包含重复实例 ID')"
  ),
  debt(
    'src/main/ipc/runtime-handlers.ts',
    "throw new InstanceStoreError('invalid-input', '只有本地实例才能接管本机 dsh web')"
  ),
  debt(
    'src/main/ipc/runtime-handlers.ts',
    "throw new InstanceStoreError('invalid-input', '只有本机实例支持重启')"
  ),
  debt(
    'src/main/ipc/runtime-handlers.ts',
    "throw new InstanceStoreError('invalid-state', '实例未在运行，无法重启')"
  ),
  debt('src/main/ipc/runtime-handlers.ts', "'外部接管的 dsh 进程归用户所有，不能由 hub 重启'"),
  debt('src/main/ipc/errors.ts', "export const SCANNER_UNAVAILABLE = '本机进程探测能力不可用'"),
  debt(
    'src/main/ipc/errors.ts',
    'export const notFoundDshPid = (pid: number): string => `未找到 pid ${pid} 的 dsh web 进程`'
  ),
  debt(
    'src/main/ipc/ipc-utils.ts',
    "if (/\\s/.test(access)) throw new InstanceStoreError('invalid-input', '访问 token 不能包含空白')"
  ),
  debt(
    'src/main/ipc/errors.ts',
    "export const LISTEN_PORT_UNDETERMINED = '该进程的监听端口未能确定，无法接管'"
  ),
  debt(
    'src/main/ipc/instance-handlers.ts',
    "if (record.transport !== 'local') throw new Error('本机实例创建结果无效')"
  ),
  debt('src/main/ipc/ipc-utils.ts', "'访问链接必须匹配已检测的本机 dsh 端口并包含 token'"),
  debt(
    'src/main/ipc/ipc-utils.ts',
    "throw new InstanceStoreError('invalid-input', '访问链接无法解析')"
  ),
  debt('src/main/ipc/runtime-handlers.ts', "'本机 dsh 已重启，请在实例详情中更新访问 token'"),
  debt('src/main/ipc/runtime-handlers.ts', "'本机 dsh 的访问 token 已失效，请在实例详情中更新'"),
  debt(
    'src/main/ipc/runtime-handlers.ts',
    "throw new InstanceStoreError('invalid-state', '实例已在运行，不能接管其他本机 dsh web')"
  ),
  debt('src/main/ipc/runtime-handlers.ts', "'本机 dsh 需要访问 token，请在实例详情中更新'"),
  debt(
    'src/main/ipc/errors.ts',
    "export const EXTERNAL_ACCESS_TOKEN_INVALID = '访问 token 无效，请重新输入'"
  ),
  debt(
    'src/main/workspace-host.ts',
    "if (!win || win.isDestroyed()) throw new Error('工作区主窗口不可用')"
  ),
  debt('src/main/local-runtime/local-runtime.ts', "detail: '实例已在运行，忽略重复接管'"),
  debt('src/shared/contracts-instance.ts', ".min(1, '配置档案不能为空')"),
  debt('src/shared/contracts-instance.ts', ".max(128, '配置档案最长 128 字符')"),
  debt(
    'src/shared/contracts-instance.ts',
    ".regex(PROFILE_PATTERN, '配置档案只能是相对路径，且不能以 - 开头')"
  ),
  debt(
    'src/shared/contracts-instance.ts',
    "const DSH_VERSION_SCHEMA = z.string().trim().max(64).regex(DSH_VERSION_PATTERN, '版本号含非法字符')"
  ),
  debt('src/shared/contracts.ts', ".min(1, '插件标识不能为空')"),
  debt('src/shared/contracts.ts', ".max(512, '插件标识过长')"),
  debt(
    'src/shared/contracts.ts',
    "}, '插件标识形态非法（仅支持 npm 名 / name@version / github: / file:）')"
  ),
  debt(
    'src/shared/contracts.ts',
    ".regex(/^(@[a-z0-9][\\w.-]*\\/)?[a-z0-9][\\w.-]*$/i, '插件名形态非法')"
  ),
  debt(
    'src/shared/contracts-instance.ts',
    ".refine((value) => !value.split('/').includes('..'), '配置档案不能包含 ..')"
  ),
  debt(
    'src/shared/settings.ts',
    ".refine((value) => value === '' || isAllowedNpmRegistry(value), '镜像地址必须是 https URL')"
  ),

  debt(
    'src/main/local-runtime/local-runtime.ts',
    "detail: `已接管本机运行的 dsh web（pid ${external.pid}${external.patch ? `，patch ${external.patch}` : ''}）`"
  ),
  debt(
    'src/main/local-runtime/local-runtime.ts',
    "detail: `已断开接管（外部 dsh web 进程 pid ${entry.externalPid ?? '?'} 未终止）`"
  ),
  debt(
    'src/main/ipc/auth-handlers.ts',
    "throw new InstanceStoreError('invalid-input', '未勾选「记住密码」，没有已保存的密码可用')"
  ),
  debt(
    'src/main/ipc/auth-handlers.ts',
    "throw new InstanceStoreError('invalid-input', '保险库中没有该实例的已存密码')"
  ),
  debt(
    'src/main/ipc/version-handlers.ts',
    "if (!deps.installer) throw new InstanceStoreError('internal', 'dsh 版本管理能力不可用')"
  ),
  debt(
    'src/main/ipc/version-handlers.ts',
    "throw new InstanceStoreError('invalid-input', '该实例不支持升级')"
  ),
  debt(
    'src/main/local-runtime/runtime-installer.ts',
    "onProgress?.({ phase: 'installing', version, detail: '校验安装结果' })"
  ),
  debt(
    'src/main/local-runtime/runtime-installer.ts',
    "onProgress?.({ phase: 'installing', version, detail: '安装完成' })"
  ),

  // —— 插件管理 IPC 信封 message（渲染层 toast 直接展示 result.message） ——
  debt('src/main/ipc/plugin-handlers.ts', ".regex(DSH_VERSION_PATTERN, '版本号含非法字符')"),
  debt(
    'src/main/ipc/plugin-handlers.ts',
    "throw new InstanceStoreError('invalid-input', '仅本机实例支持插件管理')"
  ),
  debt(
    'src/main/ipc/plugin-handlers.ts',
    "if (!deps.pluginManager) throw new InstanceStoreError('internal', '插件管理能力不可用')"
  ),
  debt('src/main/ipc/plugin-handlers.ts', "'链接必须是 npmjs.com 或 github.com 的 https 地址'"),
  debt(
    'src/main/ipc/plugin-handlers.ts',
    "if (!deps.openExternalUrl) throw new InstanceStoreError('internal', '打开外链不可用')"
  ),
  debt(
    'src/main/local-runtime/plugin-manager.ts',
    'if (!current) throw new Error(`插件未安装：${name}`)'
  ),
  debt(
    'src/main/local-runtime/plugin-command.ts',
    "`dsh plugin ${fullArgs.join(' ')} 失败（exit ${result.code}）：${tail || '无 stderr'}`"
  ),
  debt('src/main/local-runtime/plugin-manager.ts', "throw new Error('无法解析插件列表输出')"),
  debt('src/main/local-runtime/plugin-manager.ts', "throw new Error('无法解析插件版本信息输出')"),
  debt(
    'src/main/local-runtime/plugin-view-meta.ts',
    "throw new InstanceStoreError('internal', '无法解析插件版本信息输出')"
  ),
  debt(
    'src/main/local-runtime/plugin-install-plan.ts',
    "if (picked === null) throw new InstanceStoreError('internal', '无法解析插件版本信息输出')"
  ),
  debt(
    'src/main/local-runtime/plugin-registry-meta.ts',
    "throw new InstanceStoreError('not-found', `版本不存在：${name}@${version}`)"
  ),
  debt(
    'src/main/local-runtime/plugin-install-plan.ts',
    "throw new InstanceStoreError('not-found', `registry 没有标签 ${requested}：${name}`)"
  ),
  debt(
    'src/main/local-runtime/plugin-install-plan.ts',
    '`无法解析版本：插件 ${name} 未发布到 npm registry`'
  ),
  debt(
    'src/main/local-runtime/plugin-dsh-entry.ts',
    "'未找到可用的 dsh：hub 隔离目录与 PATH 上都没有已安装的运行时'"
  ),
  debt(
    'src/main/local-runtime/plugin-manager.ts',
    "throw new InstanceStoreError('not-found', `插件未安装：${name}`)"
  ),
  debt(
    'src/main/local-runtime/plugin-manager.ts',
    "throw new InstanceStoreError('invalid-input', '该插件不含 host 半，无法单独禁用')"
  ),
  debt(
    'src/main/local-runtime/plugin-manager.ts',
    '`无法检查更新：插件 ${name} 未发布到 npm registry（本地安装的包不在 registry 中）`'
  ),
  debt(
    'src/main/local-runtime/profile-bundles.ts',
    "if (!isRecord(manifest)) throw new Error('profile package.json 结构异常，未做改动')"
  ),
  debt(
    'src/main/local-runtime/profile-bundles.ts',
    "throw new Error('该实例的 profile 尚未初始化（缺少 package.json），请先启动一次实例')"
  ),
  debt(
    'src/main/local-runtime/profile-bundles.ts',
    'throw new Error(`profile 正被 dsh 占用（${lockPath}），请稍后重试`)'
  ),

  // Runtime status messages displayed by App.tsx and DetailView.
  debt(
    'src/main/local-runtime/launch.ts',
    ": '分配端口并启动进程（端口区间不可用，改由 dsh 自动选择）'"
  ),
  debt('src/main/transport/http-endpoint.ts', ": '按配置使用网关登录'"),
  debt('src/main/transport/http-endpoint.ts', "? '按配置跳过登录认证'"),
  debt('src/main/local-runtime/launch.ts', '? `分配端口并启动进程（端口 ${preferredPort}）`'),
  debt(
    'src/main/local-runtime/runtime-installer.ts',
    "`安装 ${DSH_PACKAGE_NAME}@${version} 失败（exit ${result.code}）：${tailLines(result.stderr, 20) || '无 stderr'}`"
  ),
  debt(
    'src/main/local-runtime/runtime-installer.ts',
    "throw new Error('npm 不可用：系统 PATH 和常见安装位置均未找到 npm')"
  ),
  debt(
    'src/main/local-runtime/npm-invocation.ts',
    'timeoutError = new Error(`npm 执行超时（${COMMAND_TIMEOUT_MS} ms），已终止`)'
  ),
  debt(
    'src/main/local-runtime/npm-invocation.ts',
    "abortError = new Error('npm 执行已取消（应用退出）')"
  ),
  debt(
    'src/main/local-runtime/npm-invocation.ts',
    'reject(new Error(`npm 执行被信号终止（${signal}）`))'
  ),
  debt('src/main/local-runtime/local-runtime.ts', "detail: '实例已在运行，忽略重复启动'"),
  debt('src/main/local-runtime/launch.ts', "detail: '实例已在运行，忽略重复启动'"),
  debt(
    'src/main/local-runtime/launch.ts',
    'throw new Error(`未找到启动器 ${customLauncherName}（PATH 与常见安装位置均未探到）`)'
  ),
  debt(
    'src/main/local-runtime/launch.ts',
    'throw new Error(`无法解析启动器脚本（${scriptPath}）`)'
  ),
  debt(
    'src/main/local-runtime/local-runtime-upgrade.ts',
    "'外部接管的 dsh 进程归用户所有，hub 不能代管升级'"
  ),
  debt('src/main/transport/ssh-tunnel.ts', "detail: '隧道已在运行，忽略重复启动'"),
  debt(
    'src/main/transport/ssh-tunnel.ts',
    'detail: `SSH 隧道已就绪（127.0.0.1:${entry.localPort} → ${entry.remoteLabel}）`'
  ),
  debt(
    'src/main/transport/ssh-tunnel.ts',
    'detail: `SSH 隧道断开（${attribution.message}）；${entry.backoffMs / 1000}s 后自动重连`'
  ),
  debt(
    'src/main/local-runtime/launch.ts',
    "detail: `启动超时（${Math.round(readyTimeoutMs / 1000)}s）：未解析到就绪 URL${entry.log.length > 0 ? `；日志 ${logTail(entry)}` : ''}`"
  ),
  debt(
    'src/main/local-runtime/runtime-installer.ts',
    'detail: `安装 ${DSH_PACKAGE_NAME}@${version}`'
  ),
  debt(
    'src/main/local-runtime/runtime-installer.ts',
    'const detail = `下载依赖 (${downloadedPaths.size})：${info.path}`'
  ),
  debt(
    'src/main/local-runtime/local-runtime-ready.ts',
    "detail: error instanceof Error ? `解析就绪地址失败：${error.message}` : '解析就绪地址失败'"
  ),
  debt(
    'src/main/local-runtime/local-runtime-ready.ts',
    "failReady(new Error('就绪 URL 无法解析'))"
  ),
  debt(
    'src/main/local-runtime/local-runtime-ready.ts',
    'failReady(new Error(`就绪 URL 主机非回环地址（${readyUrl.hostname}），已拒绝`))'
  ),
  debt(
    'src/main/local-runtime/local-runtime-ready.ts',
    '`就绪 URL 无法访问（健康探测 ${deps.healthProbeRetries} 次失败）：${url}`'
  ),
  debt(
    'src/main/local-runtime/local-runtime-ready.ts',
    'detail: `已在 ${entry.home} 启动（dsh web）`'
  ),
  // Runtime source messages.
  debt('src/main/local-runtime/launch.ts', "emit(id, 'starting', { detail: '解析运行时来源' })"),
  debt(
    'src/main/local-runtime/launch.ts',
    "emit(id, 'starting', { version: target, detail: `需要下载 dsh ${target}，等待确认` })"
  ),
  debt(
    'src/main/local-runtime/launch.ts',
    'detail: `需要下载 dsh ${target}，未获确认，已取消启动（hub 与 PATH 上均无可用运行时）`'
  ),
  debt('src/main/local-runtime/launch.ts', '? `使用本机 dsh ${version} 启动`'),
  debt(
    'src/main/local-runtime/launch.ts',
    ': `准备 dsh ${version} 运行时（首次需要安装，可能较慢）`'
  ),
  debt(
    'src/main/local-runtime/local-runtime-upgrade.ts',
    "throw new Error('未找到系统默认 dsh（PATH 上没有可用的 dsh），无法升级')"
  ),
  debt(
    'src/main/local-runtime/local-runtime-upgrade.ts',
    'throw new Error(`系统 dsh 不是 npm 全局安装（${system.command}），hub 无法代管升级`)'
  ),
  debt(
    'src/main/local-runtime/runtime-installer.ts',
    'detail: `全局安装 ${DSH_PACKAGE_NAME}@${version}（${prefix}）`'
  ),
  debt(
    'src/main/local-runtime/runtime-installer.ts',
    'throw new Error(`全局升级完成但未找到 dsh 入口：${entry}`)'
  ),
  debt(
    'src/main/transport/ssh-tunnel.ts',
    'detail: `建立 SSH 隧道（${localPort} → ${entry.remoteLabel}）`'
  ),
  debt(
    'src/main/local-runtime/launch.ts',
    "detail: `进程意外退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）${"
  ),
  debt(
    'src/main/local-runtime/launch.ts',
    "entry.log.length > 0 ? `；日志 ${logTail(entry)}` : ''"
  ),
  debt(
    'src/main/transport/ssh-tunnel.ts',
    "emit(entry.id, 'error', { detail: '远端 dsh 未就绪（就绪探测超时），即将自动重连' })"
  ),
  debt(
    'src/main/transport/ssh-tunnel.ts',
    "emit(entry.id, 'starting', { detail: '等待输入 SSH 口令（不落盘）' })"
  ),
  debt(
    'src/main/transport/ssh-tunnel.ts',
    "emit(entry.id, 'starting', { detail: `本地端口已重新分配为 ${port}` })"
  ),
  debt(
    'src/main/transport/ssh-tunnel.ts',
    "emit(entry.id, 'starting', { detail: `第 ${entry.reconnectCount} 次自动重连（${entry.url}）` })"
  ),
  debt('src/main/transport/ssh-tunnel.ts', "emit(entry.id, 'stopped', { detail: '实例已删除' })"),
  debt(
    'src/main/transport/ssh-tunnel.ts',
    "emit(id, 'error', { detail: '服务器指纹未确认（或已变化），已拒绝连接' })"
  ),
  debt(
    'src/main/transport/ssh-tunnel.ts',
    "emit(id, 'error', { detail: `SSH 进程启动失败：${error.message}` })"
  ),
  debt(
    'src/main/transport/http-endpoint.ts',
    "emit(id, 'error', { detail: `端点不可达：${url}（连接被拒或超时）`, url })"
  ),
  debt(
    'src/main/local-runtime/launch.ts',
    "emit(id, 'error', { detail: `进程启动失败：${error.message}` })"
  ),
  debt(
    'src/main/transport/http-endpoint.ts',
    "detail: running ? '实例已在运行，忽略重复启动' : (current?.detail ?? '正在校验端点')"
  ),
  debt(
    'src/main/transport/http-endpoint.ts',
    "detail: running ? '实例已在运行，忽略重复启动' : (status?.detail ?? '正在校验端点')"
  ),
  debt('src/main/transport/ssh-tunnel.ts', "emit(id, 'starting', { detail: '分配本地端口' })"),
  debt(
    'src/main/transport/ssh-tunnel.ts',
    "emit(id, 'starting', { detail: '口令输入通道不可用，将尝试非交互认证（agent / 免密密钥）' })"
  ),
  debt('src/main/transport/ssh-tunnel.ts', "emit(id, 'starting', { detail: '校验服务器指纹' })"),
  debt(
    'src/main/transport/ssh-tunnel.ts',
    "emit(id, 'starting', { detail: '检测到隧道已中断，重新建立连接' })"
  ),
  debt(
    'src/main/transport/ssh-tunnel.ts',
    "emit(id, 'starting', { detail: '隧道正在启动，忽略重复启动' })"
  ),
  debt(
    'src/main/transport/http-endpoint.ts',
    "emit(id, 'starting', { detail: `校验端点 ${url}` })"
  ),
  debt(
    'src/main/transport/http-endpoint.ts',
    "emit(id, 'starting', { url, detail: '探测认证模式' })"
  ),
  debt(
    'src/main/local-runtime/local-runtime.ts',
    "emit(id, 'stopped', { detail: '实例未在运行' })"
  ),
  debt('src/main/transport/http-endpoint.ts', "emit(id, 'stopped', { detail: '实例未在运行' })"),
  debt('src/main/transport/ssh-tunnel.ts', "emit(id, 'stopped', { detail: '实例未在运行' })"),
  debt('src/main/transport/http-endpoint.ts', "emit(id, 'stopped', { detail: '已停止' })"),
  debt('src/main/local-runtime/local-runtime.ts', "emit(id, 'stopped', { detail: '已取消启动' })"),
  debt('src/main/local-runtime/launch.ts', "emit(id, 'stopped', { detail: '已取消启动' })"),
  debt('src/main/transport/ssh-tunnel.ts', "emit(id, 'stopped', { detail: '已取消启动' })"),
  debt('src/main/transport/ssh-tunnel.ts', "emit(id, 'stopped', { detail: '隧道已停止' })"),
  debt(
    'src/main/local-runtime/local-runtime.ts',
    "emit(id, 'stopped', { detail: exited ? '已停止' : '已强制停止（SIGKILL）' })"
  ),
  debt('src/main/ssh/ssh-trust-gate.ts', "emitWaiting('服务器指纹已变化，已拒绝连接')"),
  debt('src/main/ssh/ssh-trust-gate.ts', "emitWaiting('等待确认服务器指纹')"),
  debt(
    'src/main/transport/ssh-tunnel.ts',
    "entry.pendingReason = { kind: 'connect', message: '远端 dsh 未就绪' }"
  ),
  debt(
    'src/main/transport/ssh-tunnel.ts',
    "if (secret !== null) emit(entry.id, 'starting', { detail: '已收到口令，继续建立隧道' })"
  ),
  debt(
    'src/main/local-runtime/runtime-installer.ts',
    "if (versions.length === 0) throw new Error('registry 中没有可用的 dsh 版本')"
  ),
  debt('src/main/transport/attribution.ts', "label: '主机名解析失败'"),
  debt(
    'src/main/transport/attribution.ts',
    "label: '服务器指纹未确认或被更改（请在实例详情重新确认指纹）'"
  ),
  debt('src/main/transport/attribution.ts', "label: '端口转发失败（本地端口被占或远端拒绝监听）'"),
  debt('src/main/transport/attribution.ts', "label: '连接被拒绝或中断'"),
  debt('src/main/transport/attribution.ts', "label: '连接被远端关闭'"),
  debt('src/main/transport/attribution.ts', "label: '连接超时'"),
  debt('src/main/transport/attribution.ts', "label: '鉴权失败（口令 / 密钥 / 权限）'"),
  debt(
    'src/main/transport/attribution.ts',
    "message: `${feature.label}${detail ? `（${detail}）` : ''}`"
  ),
  debt(
    'src/main/transport/attribution.ts',
    "message: `SSH 会话异常退出（code=${code ?? 'null'}）` + (evidence ? `；${evidence}` : '')"
  ),
  debt('src/main/transport/http-endpoint.ts', "return '无需登录认证，可直接访问'"),
  debt('src/main/transport/http-endpoint.ts', "return '检测到 dsh 内置浏览器认证（页面内自认证）'"),
  debt('src/main/transport/http-endpoint.ts', 'return `检测到登录认证（${detection.evidence}）`'),
  debt(
    'src/main/transport/attribution.ts',
    "return { kind: 'closed', message: 'SSH 进程正常退出（退出码 0）' }"
  ),
  debt(
    'src/main/local-runtime/port-allocator.ts',
    'throw new Error(`端口段 ${start}-${end} 内没有可用端口`)'
  ),
  debt(
    'src/main/local-runtime/runtime-installer.ts',
    'throw new Error(`读取可用版本失败：${result.stderr.trim() || `exit ${result.code}`}`)'
  ),
  debt('src/main/local-runtime/runtime-installer.ts', 'throw new Error(`非法版本号：${version}`)'),

  // —— 认证状态 message（AuthPanel 的 auth-message） ——
  debt('src/main/auth/gateway-client.ts', "'invalid-backup-code': '备份码无效',"),
  debt('src/main/auth/gateway-client.ts', "'invalid-credentials': '账号或验证码错误',"),
  debt('src/main/auth/gateway-client.ts', "'invalid-otp': '动态验证码错误',"),
  debt('src/main/auth/gateway-client.ts', "'onboarding-required': '需要先设置新的登录密码',"),
  debt('src/main/auth/gateway-client.ts', "'otp-not-enabled': '该实例未启用动态验证码',"),
  debt('src/main/auth/gateway-client.ts', "'otp-required': '请输入动态验证码或备份码',"),
  debt(
    'src/main/auth/gateway-client.ts',
    "'otp-secret-missing': '实例的 OTP 配置异常，请联系管理员',"
  ),
  debt('src/main/auth/gateway-client.ts', "'invalid-json': '响应格式无效',"),
  debt('src/main/auth/gateway-client.ts', "'bad-request': '请求无效',"),
  debt('src/main/auth/gateway-client.ts', "network: '网络错误',"),
  debt('src/main/auth/gateway-client.ts', "unexpected: '服务返回了未知错误'"),
  debt(
    'src/main/auth/gateway-client.ts',
    'return ERROR_MESSAGES[code] ?? `请求失败（HTTP ${status}）`'
  ),
  debt('src/main/auth/gateway-client.ts', "message: '登录成功响应缺少会话 Cookie',"),
  debt('src/main/auth/gateway-client.ts', "'password-mismatch': '两次输入的密码不一致',"),
  debt('src/main/auth/gateway-client.ts', "'password-too-short': '密码太短',"),
  debt('src/main/auth/gateway-client.ts', "'password-too-simple': '密码强度不足',"),
  debt('src/main/auth/gateway-client.ts', "'payload-too-large': '请求体过大',"),
  debt('src/main/auth/gateway-client.ts', "'rate-limited': '尝试过于频繁，请稍后再试',"),
  debt('src/main/auth/gateway-client.ts', "'too-many-attempts': '失败次数过多，账号已临时锁定',"),
  debt('src/main/auth/gateway-state.ts', "message: '该实例需要先设置新的登录密码'"),
  debt('src/main/auth/gateway-state.ts', "message: '账号或验证码错误'"),
  debt(
    'src/main/auth/gateway-client.ts',
    "message: error instanceof Error ? `网络错误：${error.message}` : '网络错误',"
  ),
  debt('src/main/auth/gateway-client.ts', "unauthenticated: '登录状态已失效，请重新登录',"),

  // —— 探测 evidence（UrlDetect 直接展示 detection.evidence） ——
  debt('src/main/auth/detect.ts', "evidence: '401 + dsh 内置 BrowserAuth 提示（webview 自认证）',"),
  debt('src/main/auth/detect.ts', "evidence: '401（无识别特征）',"),
  debt(
    'src/main/auth/detect.ts',
    "evidence: `${status} → ${location || '(无 Location)'}（未识别的重定向）`,"
  ),
  debt('src/main/auth/detect.ts', 'evidence: `${status} → ${location}（网关 onboarding 未完成）`,'),
  debt('src/main/auth/detect.ts', 'evidence: `${status} → ${location}（网关登录页重定向）`,'),
  debt('src/main/auth/detect.ts', 'evidence: `${status} → ${location}（网关要求二因素验证）`,'),
  debt('src/main/auth/detect.ts', 'evidence: `${status} 可直接访问（无需登录）`,'),
  debt(
    'src/main/auth/detect.ts',
    "evidence: `401 JSON${error ? ` error=${error}` : ''}（网关 API 直探）`,"
  ),
  debt('src/main/auth/detect.ts', 'evidence: `连接失败：${message}`,'),

  // —— askpass 提示语（口令弹窗副标题 SshDialogs.tsx:203 直接渲染 prompt） ——
  //    第 1 条在生成脚本里：ssh 正常都会把提示语作为 argv[2] 传进来，这条只是兜底；
  //    一旦命中，它会被脚本原样发给主进程并显示在弹窗里（与第 2 条主进程兜底同一句文案）。
  debt('src/main/ssh/askpass.ts', "const prompt = process.argv[2] || 'SSH 需要输入口令'"),
  debt('src/main/ssh/askpass.ts', "let prompt = 'SSH 需要输入口令'"),

  // —— 指纹展示值（指纹确认弹窗） ——
  debt('src/main/ssh/host-trust.ts', "return 'SHA256:<无法解析>'"),

  //    渠道:zod 的 message 经 `formatZodIssues`(contracts.ts:510-517)折叠成一条纯文本,
  //    塞进 IPC 错误信封 `message`(`register.ts` 的 invalid-input 分支)→ 渲染层 toast /
  //    迁移方式同 (a):改成稳定 code + 渲染层按 field/code 映射文案。
  debt('src/shared/contracts-instance.ts', ".number('端口必须是数字')"),
  debt('src/shared/contracts-instance.ts', ".int('端口必须是整数')"),
  debt('src/shared/contracts-instance.ts', ".min(1, '端口最小 1')"),
  debt('src/shared/contracts-instance.ts', ".max(65535, '端口最大 65535')"),
  debt('src/shared/contracts-instance.ts', ".min(1, 'SSH 主机不能为空')"),
  debt('src/shared/contracts-instance.ts', ".max(255, 'SSH 主机最长 255 字符')"),
  debt(
    'src/shared/contracts-instance.ts',
    ".regex(/^[A-Za-z0-9._\\-:[\\]]+$/, 'SSH 主机含非法字符（不允许空白 / 斜杠 / @）')"
  ),
  debt(
    'src/shared/contracts-instance.ts',
    ".refine((value) => !value.startsWith('-'), 'SSH 主机不能以 - 开头')"
  ),
  debt(
    'src/shared/contracts-instance.ts',
    ".refine(isValidSshHost, 'host[:port] 形态的端口必须在 1–65535，或主机名不含冒号')"
  ),
  debt(
    'src/shared/contracts-instance.ts',
    "name: z.string().trim().min(1, '名称不能为空').max(64, '名称最长 64 字符'),"
  ),
  debt(
    'src/shared/contracts-instance.ts',
    "notes: z.string().trim().max(2000, '备注最长 2000 字符').nullable().optional(),"
  ),
  debt(
    'src/shared/contracts-instance.ts',
    "username: z.string().trim().min(1, 'SSH 用户名不能为空').max(128, 'SSH 用户名最长 128 字符'),"
  ),
  debt(
    'src/shared/contracts-instance.ts',
    "'端点 URL 无法解析（仅支持 http/https，禁止内嵌凭据 / 查询串 / 锚点）'"
  ),
  debt(
    'src/shared/contracts-instance.ts',
    "name: z.string().trim().min(1, '名称不能为空').max(64).optional(),"
  ),
  debt(
    'src/shared/contracts-instance.ts',
    "username: z.string().trim().min(1, 'SSH 用户名不能为空').max(128),"
  ),
  debt(
    'src/shared/contracts-instance.ts',
    ".refine((patch) => Object.keys(patch).length > 0, '补丁不能为空')"
  ),
  debt(
    'src/shared/contracts-instance.ts',
    "schemaVersion: z.number('schemaVersion 必须是数字').int().min(1),"
  ),

  //    渠道:`EndpointParseError.message` → `register.ts` wrap 的 invalid-input 信封 message
  //    → `Wizard.tsx:83/120` 与 `UrlDetect.tsx:65` 的 `setError(result.message)` **直接上屏**。
  //    迁移同样只需把静态文案换成 code。
  debt(
    'src/shared/endpoint.ts',
    "throw new EndpointParseError('empty', input, '端点地址不能为空')"
  ),
  debt(
    'src/shared/endpoint.ts',
    "throw new EndpointParseError('missing-host', input, '端点地址缺少主机名')"
  ),
  debt(
    'src/shared/endpoint.ts',
    "throw new EndpointParseError('malformed', input, '无法解析端点地址')"
  ),
  debt(
    'src/shared/endpoint.ts',
    "throw new EndpointParseError('credentials-not-allowed', input, '端点地址不能内嵌用户名或密码')"
  ),
  debt(
    'src/shared/endpoint.ts',
    "throw new EndpointParseError('query-not-supported', input, '端点地址不支持查询参数')"
  ),
  debt(
    'src/shared/endpoint.ts',
    "throw new EndpointParseError('hash-not-supported', input, '端点地址不支持锚点')"
  ),
  debt(
    'src/shared/endpoint.ts',
    "throw new EndpointParseError('invalid-port', input, '端口不合法')"
  ),
  debt(
    'src/shared/endpoint.ts',
    "throw new EndpointParseError('unsupported-scheme', input, '仅支持 http / https 协议')"
  )
]

/**
 * (b) 内部诊断:中文只进日志 / 被吞掉 / 当前无消费者,渲染层拿不到这些字段。
 * 每条的理由见所属分组的小标题。
 */
const NON_RENDERER_COPY_DEBT_INTERNAL: readonly DebtEntry[] = [
  // —— askpass helper 脚本内容（写盘后由 ssh 子进程执行，脚本正文从不渲染）：脚本头注释、
  //    catch 分支注释、三处 stderr 日志，以及包装脚本 askpass.sh 里的 shell 注释 ——
  debt(
    'src/main/ssh/askpass.ts',
    "'# 由 DSH Hub 运行时写入：用自带 Node 执行 askpass helper（不依赖 PATH 中的 node）',"
  ),
  debt('src/main/ssh/askpass.ts', '/* 落到取消分支 */'),
  debt(
    'src/main/ssh/askpass.ts',
    'export const ASKPASS_HELPER_SOURCE = `// 由 DSH Hub 运行时写入；把 ssh 的口令提示转发给主进程，答案只经 stdout 回给 ssh。'
  ),
  debt(
    'src/main/ssh/askpass.ts',
    "process.stderr.write('askpass: DSH_HUB_ASKPASS_SOCKET 未设置\\\\n')"
  ),
  debt('src/main/ssh/askpass.ts', "process.stderr.write('askpass: 等待用户输入超时\\\\n')"),
  debt(
    'src/main/ssh/askpass.ts',
    "process.stderr.write('askpass: 通道失败 ' + error.message + '\\\\n')"
  ),

  // —— 注册表损坏隔离原因:只进 console.warn 与隔离文件名,不进任何 IPC/状态字段 ——
  debt('src/main/registry/instance-store.ts', "await quarantineCorruptFile('JSON 解析失败')"),
  debt(
    'src/main/registry/instance-store.ts',
    'await quarantineCorruptFile(`schema 校验失败：${reason}`)'
  ),
  debt(
    'src/main/registry/instance-store.ts',
    '`schemaVersion=${from} 高于当前 ${REGISTRY_SCHEMA_VERSION}，拒绝降级`'
  ),
  debt(
    'src/main/registry/instance-store.ts',
    'await quarantineCorruptFile(`缺少 schemaVersion ${v} → ${v + 1} 的迁移器`)'
  ),

  // —— 普通 Error(message 为中文):IPC 边界统一换成稳定码的固定文案(register.ts wrap 的 internal),明细只进主进程日志;或被调用方 catch 后只 console.error ——
  debt('src/main/ssh/key-preview.ts', "else reject(error ?? new Error('ssh -G 未返回任何配置'))"),
  debt('src/main/ssh/host-trust.ts', "else reject(error ?? new Error('ssh -G 未返回任何配置'))"),
  debt('src/main/vault/vault.ts', "if (password === '') throw new Error('空密码不写入 vault')"),
  debt('src/main/vault/vault.ts', "if (token === '') throw new Error('空访问 token 不写入 vault')"),
  debt(
    'src/main/vault/vault.ts',
    "if (session.value === '') throw new Error('空会话不写入 vault')"
  ),
  debt('src/main/vault/vault.ts', 'throw new Error(`未勾选「${field}」,拒绝写入 vault`)'),

  // —— vault 的 onError 回调:缺省实现是 console.error('[vault] 操作失败：', error),只进日志 ——
  debt('src/main/vault/vault.ts', "onError(new Error('vault 会话载荷不是合法 JSON,已丢弃'))"),
  debt('src/main/vault/vault.ts', "onError(new Error('vault 文件格式不符,已忽略'))"),

  // —— ssh-keyscan 失败被 ensureTrust 的 catch {} 吞掉(不判 TOFU、不显示),交给 ssh 自己连接并归因 ——
  debt(
    'src/main/ssh/host-trust.ts',
    "else reject(error ?? new Error('ssh-keyscan 未返回任何公钥'))"
  ),

  // —— 工厂参数断言(调用方传常量):纯程序员错误,不会出现在界面上 ——
  debt(
    'src/main/auth/backoff.ts',
    "if (!Number.isInteger(limit) || limit < 1) throw new Error('并发上限必须是正整数')"
  ),

  // —— 当前**没有任何消费者**:backoff 的 reason 只写不读;auth-client 的 evidence 被两处 probe 调用方丢弃(register.ts:344 / index.ts:630),session-restored 分支 message 置 null ——
  debt('src/main/auth/auth-client.ts', "evidence: '已存会话有效（静默恢复）',"),
  debt('src/main/auth/backoff.ts', "reason = why ?? '请求过于频繁，已暂停自动重试'"),

  // —— redact.ts 的正则字符类含中文标点(。，；！？、):用于排除 URL 末尾标点,是正则语法不是界面文案 ——
  debt(
    'src/shared/redact.ts',
    'return line.replace(/https?:\\/\\/[^\\s,。，；！？、()]+/gi, (match) => redactUrl(match))'
  ),

  // —— 实例排序校验错误:只在主进程 IPC 边界抛出,由 wrap() 转为固定码 ——
  debt(
    'src/main/ipc/instance-handlers.ts',
    "throw new InstanceStoreError('invalid-input', '排序列表必须是字符串数组')"
  ),
  debt(
    'src/main/registry/instance-store.ts',
    '`排序列表长度(${orderedIds.length})与实例数量(${current.length})不一致`'
  ),
  debt(
    'src/main/registry/instance-store.ts',
    "throw new InstanceStoreError('invalid-input', `排序列表包含未知实例 ID：${id}`)"
  ),

  // —— 顶层失败记录器:deps.log 由 index.ts 接到 console.error,只进主进程日志,不经任何 IPC/状态字段 ——
  debt(
    'src/main/shell/top-level-failure.ts',
    'deps.log(`[main] 未处理的 Promise 拒绝：${describeReason(reason)}`)'
  ),
  debt(
    'src/main/shell/top-level-failure.ts',
    'deps.log(`[main] 未捕获的异常：${describeReason(error)}`)'
  )
]

/**
 * 两份清单的并集:(a) 用户可见待迁移 + (b) 内部诊断。
 * 站点身份 = (路径, 文案):同一文案出现在不同文件必须逐站点登记,同文件同文案只算一个
 * 站点(身份不含行号)。站点数随特性增删而变化,以下方「主进程文案受约束」用例的
 * 等号断言为准 —— 计数不写死在注释里,避免注释与清单脱节。
 */
const NON_RENDERER_COPY_DEBT: readonly DebtEntry[] = [
  ...NON_RENDERER_COPY_DEBT_USER_VISIBLE,
  ...NON_RENDERER_COPY_DEBT_INTERNAL
]

// ───────────────────────── 用例 ─────────────────────────

const formatViolations = (violations: readonly Violation[]): string =>
  `以下位置仍有硬编码文案，应改用 t('...'):\n` +
  violations
    .map((violation) => `  ${violation.path}:${violation.line}  ${violation.text}`)
    .join('\n')

const COPY_DEBT_HINT = [
  '',
  '处置方式(二选一):',
  '  1. 用户可见(会经 IPC message / 状态 detail / 认证 message / 探测 evidence / zod 校验文案 /',
  '     端点解析错误文案 / 提示语到达界面):文案搬进 @shared/i18n/messages.ts，渲染层按',
  '     code / key 展示，并把该行登记进 NON_RENDERER_COPY_DEBT_USER_VISIBLE',
  '     (推荐;此变更影响接口展示方式，应单独处理);',
  '  2. 确属非用户可见(例如只进日志/被 catch 吞掉/当前无消费者):登记进 NON_RENDERER_COPY_DEBT_INTERNAL，',
  '     并在该分组的小标题里写明为什么它不可能出现在界面上 —— 这是对“债务只减不增”的有意确认，',
  '     不要为了变绿放宽规则。'
].join('\n')

function migratedPath(name: string): string {
  return name.startsWith('../') ? join(RENDERER_SRC, name.slice(3)) : join(COMPONENTS_DIR, name)
}

/**
 * 比较扫描到的站点与登记站点。
 * `unregistered` 表示新增站点，`stale` 表示不再存在的登记站点。
 */
export function diffDebt(
  violations: readonly Violation[],
  registered: readonly DebtEntry[]
): { unregistered: string[]; stale: string[] } {
  const observed = [
    ...new Set(violations.map((violation) => siteKey(violation.path, violation.text)))
  ]
    .sort()
    .map(readableSite)
  const pinned = registered
    .map(([file, text]) => siteKey(file, text))
    .sort()
    .map(readableSite)
  const observedSet = new Set(observed)
  const pinnedSet = new Set(pinned)
  return {
    unregistered: observed.filter((key) => !pinnedSet.has(key)),
    stale: pinned.filter((key) => !observedSet.has(key))
  }
}

describe('i18n 覆盖检查', () => {
  it('渲染层整树(.ts/.tsx/.css/.html,递归)默认受约束:不含硬编码中日韩文案', () => {
    const files = collectScannedFiles().filter((file) => isRendererPath(file.path))
    // 反“空扫”:遍历不到文件时,下面的断言会毫无意义地变绿
    expect(files.length, '渲染层应能遍历到源文件').toBeGreaterThan(15)
    expect(
      files.some((file) => file.path === 'src/renderer/index.html'),
      '渲染层 index.html 必须在扫描集合内，以检查 `<title>` 文案'
    ).toBe(true)
    const violations = scanSources(
      files.filter((file) => !isPending(file.path)),
      { allowedLiterals: ALLOWED_LITERALS }
    )
    expect(violations, formatViolations(violations)).toEqual([])
  })

  it('新增文件默认受约束:渲染层根目录、嵌套子目录、CSS 与 index.html 里的文案都会被扫到', () => {
    const synthetic: SourceFile[] = [
      { path: 'src/renderer/src/NewView.tsx', text: 'export const A = () => <p>硬编码文案</p>\n' },
      {
        path: 'src/renderer/src/components/nested/x.tsx',
        text: 'export const B = () => <p>嵌套目录文案</p>\n'
      },
      {
        path: 'src/renderer/src/styles-extra.css',
        text: '.x::after { content: "伪元素文案"; }\n'
      },
      {
        path: 'src/renderer/index.html',
        text: '<!doctype html>\n<html>\n  <head>\n    <title>数据目录控制台</title>\n  </head>\n</html>\n'
      },
      { path: 'src/renderer/src/clean.ts', text: 'export const c = 1\n' }
    ]
    const violations = scanSources(synthetic, { allowedLiterals: ALLOWED_LITERALS })
    expect(violations.map((violation) => `${violation.path}:${violation.line}`)).toEqual([
      'src/renderer/src/NewView.tsx:1',
      'src/renderer/src/components/nested/x.tsx:1',
      'src/renderer/src/styles-extra.css:1',
      'src/renderer/index.html:4'
    ])
  })

  it('目录遍历是递归的:嵌套子目录里的新文件同样会被收集', () => {
    const dir = mkdtempSync(join(tmpdir(), 'i18n-guard-'))
    try {
      mkdirSync(join(dir, 'a/b/c'), { recursive: true })
      writeFileSync(join(dir, 'root.tsx'), 'export const a = 1\n')
      writeFileSync(join(dir, 'a/b/c/deep.tsx'), 'export const b = 2\n')
      writeFileSync(join(dir, 'note.css'), '.a {}\n')
      writeFileSync(join(dir, 'index.html'), '<title>DSH Hub</title>\n')
      writeFileSync(join(dir, 'skip.test.tsx'), 'export const c = 3\n')
      const found = collectSourceFiles(dir, SOURCE_EXTENSIONS, isTestFile)
      expect(found.length, '只应收集到非测试的 .ts/.tsx/.css/.html').toBe(4)
      const paths = found.map((file) => file.path)
      expect(paths.some((path) => path.endsWith('root.tsx'))).toBe(true)
      expect(paths.some((path) => path.endsWith('a/b/c/deep.tsx'))).toBe(true)
      expect(paths.some((path) => path.endsWith('note.css'))).toBe(true)
      expect(paths.some((path) => path.endsWith('index.html'))).toBe(true)
      expect(paths.some((path) => path.endsWith('skip.test.tsx'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('扫描范围覆盖整个 src 树中的 shared、preload、main 和 index.html', () => {
    // 一旦有人把根目录从 `src/` 缩回 `src/renderer`+`src/main`,这条用例先失败。
    const paths = collectScannedFiles().map((file) => file.path)
    // 四个目录 + 渲染层 index.html 都必须有代表文件(缺任一个都说明范围被缩回去了)
    for (const required of [
      'src/main/index.ts',
      'src/shared/endpoint.ts',
      'src/shared/contracts.ts',
      'src/shared/settings.ts',
      'src/shared/bridge.ts',
      'src/preload/index.ts',
      'src/renderer/index.html'
    ]) {
      expect(paths.includes(required), `${required} 必须被扫描到`).toBe(true)
    }
    // 测试文件与文案目录是唯一的两类例外 —— 且排除必须**真的在做事**:
    // 未经过滤的整树集合里它们**存在**,过滤后的扫描集合里它们**不存在**
    // (只断言后者会是恒真式,等于没测)
    const unfiltered = collectSourceFiles(SRC_ROOT, SOURCE_EXTENSIONS).map((file) => file.path)
    expect(unfiltered.includes('src/shared/i18n/messages.ts')).toBe(true)
    expect(unfiltered.some((path) => isTestFile(path))).toBe(true)
    expect(paths.includes('src/shared/i18n/messages.ts')).toBe(false)
    expect(paths.some((path) => isTestFile(path))).toBe(false)
  })

  it('非渲染层(main + shared + preload)文案受约束:未登记的硬编码中文即失败,债务清单只减不增', () => {
    // 非渲染层的中文会经 IPC 信封 message / 状态事件 detail / 认证 message / 诊断 evidence /
    // zod 校验文案 / 端点解析错误文案到达界面(渲染层直接展示这些字段),所以必须纳入扫描 ——
    const files = collectScannedFiles().filter((file) => !isRendererPath(file.path))
    expect(files.length, '非渲染层应能遍历到源文件').toBeGreaterThan(20)
    expect(
      files.some((file) => file.path === 'src/shared/endpoint.ts'),
      'src/shared 必须在非渲染层扫描集合内'
    ).toBe(true)
    // 扫描全部站点后再与清单双向比较，以识别新增和已移除的条目。
    const violations = scanSources(files, { logSinks: LOG_SINK_ENABLED })
    const { unregistered, stale } = diffDebt(violations, NON_RENDERER_COPY_DEBT)
    expect(
      { unregistered, stale },
      [
        '非渲染层出现未登记的硬编码中文文案，或债务清单已经过期:',
        formatViolations(violations),
        COPY_DEBT_HINT
      ].join('\n')
    ).toEqual({ unregistered: [], stale: [] })
    expect(
      new Set(NON_RENDERER_COPY_DEBT.map(([file, text]) => siteKey(file, text))).size,
      '债务清单里不应有重复站点'
    ).toBe(NON_RENDERER_COPY_DEBT.length)
    expect(
      NON_RENDERER_COPY_DEBT.length,
      '债务清单不应是空的(否则等于没有扫描非渲染层)'
    ).toBeGreaterThan(0)
  })

  it('非渲染层债务必须逐条归类:用户可见(a) ∪ 内部诊断(b) 恰好等于债务清单', () => {
    // 这条用例是「债务可行动」的机械保证:(b) 不是“先塞进去再说”的口袋 ——
    // 每条中文都得明确回答「会不会显示在界面上」,否则 (a)/(b) 的划分就是自说自话。
    const classified = [...NON_RENDERER_COPY_DEBT_USER_VISIBLE, ...NON_RENDERER_COPY_DEBT_INTERNAL]
    const classifiedSites = classified.map(([file, text]) => siteKey(file, text))
    const debtSites = NON_RENDERER_COPY_DEBT.map(([file, text]) => siteKey(file, text))
    expect(new Set(classifiedSites).size, '同一站点只能归一类:(a) 与 (b) 不得重叠').toBe(
      classifiedSites.length
    )
    expect([...classifiedSites].sort(), '有未归类的债务行(或清单被改坏)').toEqual(
      [...debtSites].sort()
    )
    expect(
      NON_RENDERER_COPY_DEBT_USER_VISIBLE.length,
      '(a) 用户可见待迁移清单不应为空'
    ).toBeGreaterThan(0)
    expect(NON_RENDERER_COPY_DEBT_INTERNAL.length, '(b) 内部诊断清单不应为空').toBeGreaterThan(0)
  })

  it('非渲染层债务身份包含路径，并识别新文件中的重复文案', () => {
    const files = collectScannedFiles().filter((file) => !isRendererPath(file.path))
    const base = scanSources(files, { logSinks: LOG_SINK_ENABLED })
    // 底座:真实仓库当前双向都空(这条也保证下面的对照不是靠“本来就红”蒙对)
    expect(diffDebt(base, NON_RENDERER_COPY_DEBT)).toEqual({ unregistered: [], stale: [] })

    const registered = NON_RENDERER_COPY_DEBT_USER_VISIBLE.find(([, text]) =>
      text.includes("'端点地址不能为空'")
    )
    expect(registered, '这条已登记的端点文案必须还在清单里(否则本用例失去意义)').toBeDefined()
    const [registeredFile, registeredText] = registered ?? ['', '']
    expect(registeredFile, '已登记的站点应该钉在 shared/endpoint.ts').toBe('src/shared/endpoint.ts')

    const duplicated = scanSources(
      [{ path: 'src/main/zz-debt-dup.ts', text: `${registeredText}\n` }],
      {
        logSinks: LOG_SINK_ENABLED
      }
    )
    expect(
      duplicated.map((violation) => violation.text),
      '同一条文本确实被扫到了'
    ).toEqual([registeredText])
    expect(
      diffDebt([...base, ...duplicated], NON_RENDERER_COPY_DEBT),
      '搬进新文件必须报未登记'
    ).toEqual({
      unregistered: [`src/main/zz-debt-dup.ts :: ${registeredText}`],
      stale: []
    })

    // 同一文件中的相同文本共享一个站点标识，因为标识不包含行号。
    expect(
      diffDebt(
        [...base, ...scanSources([{ path: registeredFile, text: `${registeredText}\n` }])],
        NON_RENDERER_COPY_DEBT
      ),
      '同文件同文本不构成新站点(已知缺口,身份不含行号)'
    ).toEqual({ unregistered: [], stale: [] })

    const novel = scanSources([{ path: registeredFile, text: "const x = '一条全新的界面文案'\n" }])
    expect(diffDebt([...base, ...novel], NON_RENDERER_COPY_DEBT).unregistered).toEqual([
      `src/shared/endpoint.ts :: const x = '一条全新的界面文案'`
    ])
  })

  it('主进程日志豁免只覆盖 console.* 的实参:同一行里的界面文案仍会失败', () => {
    const logged: SourceFile[] = [
      { path: 'src/main/demo.ts', text: "console.error('[demo] 日志文案:', error)\n" }
    ]
    // 同一份源码:开日志豁免=干净,关掉=违规 —— 证明豁免确实只由这条规则提供
    expect(scanSources(logged, { logSinks: true })).toEqual([])
    expect(scanSources(logged, { logSinks: false })).toHaveLength(1)

    // 四行**同一个文件**(行号才有意义):只有第 2 行是界面文案。
    const mixed: SourceFile[] = [
      {
        path: 'src/main/demo.ts',
        text: [
          "console.error('[demo] 日志文案:', error)",
          "throw new Error('信封里的界面文案')",
          "console.error('[demo] 日志:', '这也是实参')",
          "const a = 1 console.error('日志') // 行尾注释里的中文",
          ''
        ].join('\n')
      }
    ]
    // 第 2 行才是界面文案:豁免不许扩散到同一行/同一文件的其它行,注释也不参与判定
    expect(scanSources(mixed, { logSinks: true }).map((violation) => violation.line)).toEqual([2])
    // 反向确认:关掉豁免后第 1、3、4 行的日志实参也会暴露(证明豁免确实在起作用)
    expect(scanSources(mixed, { logSinks: false }).map((violation) => violation.line)).toEqual([
      1, 2, 3, 4
    ])

    const withRegex: SourceFile[] = [
      {
        path: 'src/main/demo.ts',
        text: [
          "console.error('[demo] 日志:', /\\(/.test(raw))",
          "throw new Error('正则之后的界面文案')",
          ''
        ].join('\n')
      }
    ]
    const regexText = withRegex[0]?.text ?? ''
    expect(logArgumentRegions(regexText)).toEqual([[14, 43]])
    expect(regexText.length).toBeGreaterThan(43)
    expect(scanSources(withRegex, { logSinks: true }).map((violation) => violation.line)).toEqual([
      2
    ])
  })

  it('模板字面量中的内容按文案检查，即使看起来像注释', () => {
    // 这一行在 src/main/ssh/askpass.ts 里位于 `ASKPASS_HELPER_SOURCE` 这个模板字面量**内部** ——
    // 在外层 TS 里它是字符串内容(生成脚本自己的注释),不是外层注释;剥离器按设计保留
    // 字符串/模板内容(与下面 c.ts `z//中文` 同一条规则),所以它必须被当作文案登记为债务。
    // 反过来说:任何“把模板里的注释也剥掉”的改法都会让模板里的真文案一起消失。
    const text = [
      'const S = `',
      '  } catch {',
      '    /* 落到取消分支 */',
      '  }',
      '` // 模板之后的真注释:中文不参与判定',
      ''
    ].join('\n')
    const violations = scanSources([{ path: 'src/main/askpass-like.ts', text }])
    // 只有模板内那一行算文案;模板**之后**的同款注释被正常剥离
    expect(violations.map((violation) => violation.line)).toEqual([3])
    expect(violations[0]?.text).toBe('/* 落到取消分支 */')
  })

  it('注释剥离是字符串感知的:字符串里的 `//` 不会吞掉后面的文案', () => {
    const synthetic: SourceFile[] = [
      { path: 'a.ts', text: "const a = 'x//中文'\n" },
      { path: 'b.ts', text: 'const b = "y//中文"\n' },
      { path: 'c.ts', text: 'const c = `z//中文`\n' },
      { path: 'd.ts', text: "const d = 'it\\'s //中文'\n" },
      { path: 'e.ts', text: '// 纯注释:中文\nconst e = 1\n' },
      { path: 'f.ts', text: '/* 块注释:中文 */\nconst f = 1\n' },
      { path: 'g.tsx', text: 'const g = () => <div>{/* JSX 注释:中文 */}</div>\n' }
    ]
    expect(scanSources(synthetic).map((violation) => violation.path)).toEqual([
      'a.ts',
      'b.ts',
      'c.ts',
      'd.ts'
    ])
  })

  it('注释剥离识别正则字面量:正则里的 `//` 不再吞掉后面的文案', () => {
    // Regex literals with escaped slashes must not hide following source text.
    const synthetic: SourceFile[] = [
      { path: 'g3.ts', text: "const R = /https?:\\/\\//; const X = '打开网关登录页'\n" },
      // 字符类里含 `/`、转义斜杠、`/*`、引号(引号若被当字符串起点,后面的注释判定会歪)
      { path: 'cls.ts', text: "const A = /[/]\\/\\/x/; const B = '字符类里的文案'\n" },
      { path: 'quote.ts', text: "const C = /['\"\\/]\\//; const D = '正则里的引号与斜杠'\n" },
      { path: 'block.ts', text: "const E = /\\/\\*不是块注释/; const F = '正则里的 /* '\n" },
      // 反向:真除号仍判除号,行尾/块注释照常剥离(对照组 A 的性质)
      { path: 'div.ts', text: "const G = a / b // 真注释里的中文\nconst H = '除号之后的文案'\n" },
      {
        path: 'div2.ts',
        text: "const I = (a + b) / 2 /* 块注释里的中文 */\nconst J = '除号块注释之后的文案'\n"
      },
      {
        path: 'div3.ts',
        text: "let k = 0\nk++ / 2 // 自增之后仍是除号:这行注释必须被剥离\nconst M = '自增之后的文案'\n"
      },
      // 正则之后的真注释照样剥离(不会被当成“正则的一部分”留着)
      {
        path: 'after.ts',
        text: "const N = /x/g // 行尾注释里的中文\nconst O = '正则行尾注释之后的文案'\n"
      }
    ]
    expect(
      scanSources(synthetic).map((violation) => `${violation.path}:${violation.line}`)
    ).toEqual([
      'g3.ts:1',
      'cls.ts:1',
      'quote.ts:1',
      'block.ts:1',
      'div.ts:2',
      'div2.ts:2',
      'div3.ts:3',
      'after.ts:2'
    ])
    expect(
      scanSources([
        { path: 'control.ts', text: "const R4_CONTROL = '控制组硬编码文案（无正则遮蔽）'\n" }
      ]).map((violation) => `${violation.path}:${violation.line}`)
    ).toEqual(['control.ts:1'])
  })

  it('注释剥离识别**语句位置**的正则字面量:`)`/`}` 之后的正则不再吞掉整行文案', () => {
    // 其内的第二个 `/` 与后一个 `/` 凑成 `//`,于是**整行剩余部分(含中文文案)被抹成空格**。
    const synthetic: SourceFile[] = [
      { path: 'e1-if.ts', text: "if (ok) /a\\//.test(s); const C = '文案E1'\n" },
      { path: 'e1-while.ts', text: "while (ok) /a\\//.test(s); const C = '文案E1b'\n" },
      { path: 'e1-for.ts', text: "for (;;) /a\\//.test(s); const C = '文案E1c'\n" },
      {
        path: 'e1-for-await.ts',
        text: "for await (const it of xs) /a\\//.test(it); const C = '文案E1d'\n"
      },
      // 反向对照 4:裸 `await (` 前面**没有** `for`,仍是普通括号 → `/` 是除号,该行文案必须照报
      {
        path: 'await-paren-div.ts',
        text: "const z = await (a + b) / 2 + '除号之后的文案E1e'\n"
      },
      { path: 'e2-block.ts', text: "if (ok) { f() } /a\\//.test(s); const C = '文案E2'\n" },
      { path: 'e2-fn.ts', text: "function f() {} /a\\//.test(s); const C = '文案E2b'\n" },
      { path: 'e2-fn-ret.ts', text: "function f(): void {} /a\\//.test(s); const C = '文案E2c'\n" },
      { path: 'e2-class.ts', text: "class X {} /a\\//.test(s); const C = '文案E2d'\n" },
      { path: 'e3.ts', text: "if (ok) /a\\/*/.test(s); const C = '文案E3'\n" },
      // 反向对照 1:块语句的 `}` 之后确实是**真注释**时照常剥离(不能反过来把注释留着)
      {
        path: 'block-comment.ts',
        text: "if (ok) { f() } // 这里的行尾注释必须剥离\nconst C = '块后真注释之后的文案'\n"
      },
      // 反向对照 2:**对象字面量**的 `}` 之后仍是除号(不能把「块语句」规则乱套到对象上)
      {
        path: 'object-div.ts',
        text: "const x = { a: 1 } / 2\nconst K = '对象字面量之后的文案'\n"
      },
      // 反向对照 3:普通括号的 `)` 之后仍是除号(控制语句的括号才改判)
      {
        path: 'paren-div.ts',
        text: "const y = (a + b) / 2\nconst L = '普通括号之后的文案'\n"
      }
    ]
    expect(
      scanSources(synthetic).map((violation) => `${violation.path}:${violation.line}`)
    ).toEqual([
      'e1-if.ts:1',
      'e1-while.ts:1',
      'e1-for.ts:1',
      'e1-for-await.ts:1',
      'await-paren-div.ts:1',
      'e2-block.ts:1',
      'e2-fn.ts:1',
      'e2-fn-ret.ts:1',
      'e2-class.ts:1',
      'e3.ts:1',
      'block-comment.ts:2',
      'object-div.ts:2',
      'paren-div.ts:2'
    ])
  })

  it('JSX/HTML 文本节点按文本保留:文本里的 `//` `/*` `https://` 不再被当注释', () => {
    // `<p>/*中文*/</p>` 被当块注释,`<p>https://例子.中国</p>` 的域名被吞。三者都是**真上屏文案**。
    expect(modeForPath('a.ts')).toBe('code')
    expect(modeForPath('a.tsx')).toBe('jsx')
    expect(modeForPath('a.html')).toBe('html')
    expect(modeForPath('a.css')).toBe('code')

    const synthetic: SourceFile[] = [
      { path: 'j1.tsx', text: 'const A = () => <p>//中文文案J1</p>\n' },
      { path: 'j2.tsx', text: 'const B = () => <p>/*中文文案J2*/</p>\n' },
      { path: 'j3.tsx', text: 'const C = () => <p>https://例子.中国</p>\n' },
      { path: 'j4.tsx', text: 'const D = () => <span>纯文本节点里的文案</span>\n' },
      { path: 'j5a.html', text: '<p>//中文文案J5a</p>\n' },
      { path: 'j5b.html', text: '<p>/*中文文案J5b*/</p>\n' },
      { path: 'j5c.html', text: '<p>https://例子.中国</p>\n' },
      {
        path: 'j5d.html',
        text: '<!doctype html>\n<html>\n  <head>\n    <title>数据目录控制台</title>\n  </head>\n</html>\n'
      },
      // 反向对照 1:JSX 注释仍是注释(AuthPanel.tsx 里真实存在的形态),不许报
      { path: 'ok-comment.tsx', text: 'const g = () => <div>{/* JSX 注释:中文 */}</div>\n' },
      // 反向对照 2:JSX **属性之间**的 `//` 注释仍是注释(Attributes 里的真实写法),不许报
      {
        path: 'ok-attr-comment.tsx',
        text: [
          'const m = () => (',
          '  <button',
          '    onClick={() => void submit()}',
          '    // D5:属性之间的注释:中文',
          '    disabled={x}',
          '  >',
          "    {t('a')}",
          '  </button>',
          ')',
          ''
        ].join('\n')
      },
      // 反向对照 3:HTML 注释与 `<script>` 正文(按代码处理)里的中文,不许报
      {
        path: 'ok-html.html',
        text: [
          '<!doctype html>',
          '<title>DSH Hub</title>',
          '<!-- 注释里的中文 -->',
          '<script>',
          '  // 脚本注释里的中文',
          '  const a = 1',
          '</script>',
          ''
        ].join('\n')
      }
    ]
    expect(
      scanSources(synthetic).map((violation) => `${violation.path}:${violation.line}`)
    ).toEqual([
      'j1.tsx:1',
      'j2.tsx:1',
      'j3.tsx:1',
      'j4.tsx:1',
      'j5a.html:1',
      'j5b.html:1',
      'j5c.html:1',
      'j5d.html:4'
    ])
  })

  it('注释剥离在畸形输入上仍然终止:未闭合的块注释 / HTML 注释 / 字符串都不会死循环', () => {
    const malformed: SourceFile[] = [
      {
        path: 'open-block.ts',
        text: "/* 未闭合的块注释:中文\nconst a = 1\nconst b = '后续文案'\n"
      },
      { path: 'open-html.html', text: '<!-- 未闭合的注释中文\n<p>after</p>\n' },
      { path: 'open-string.ts', text: "const s = '未闭合字符串\nconst t = '第二条'\n" },
      { path: 'open-regex.ts', text: 'const r = /未闭合的正则\nconst u = 1\n' },
      { path: 'open-template.ts', text: 'const v = `未闭合的模板\n' },
      { path: 'open-script.html', text: '<script>\nconst w = 1\n' },
      { path: 'open-jsx.tsx', text: 'const x = () => <p>未闭合的 JSX\n' }
    ]
    // 所有分支都必须返回，且报告的行号必须位于源文件范围内。
    for (const file of malformed) {
      const violations = scanSources([file])
      for (const violation of violations) {
        expect(violation.line, `${file.path} 的行号必须落在文件内`).toBeGreaterThanOrEqual(1)
        expect(violation.line).toBeLessThanOrEqual(file.text.split('\n').length)
      }
    }
    // 未闭合的块注释按设计一直抹到文件尾(没有结束标记就不猜内容边界),后续文案因此不可见;
    // 未闭合的 HTML 注释反过来**不抹**(保留为文本)→ 中文多报。两个方向都写死在用例里。
    expect(
      scanSources([{ path: 'a.ts', text: '/* 未闭合:中文\n' }]).map((v) => v.line),
      '未闭合块注释:没有结束标记 → 抹到文件尾(这条是刻意的保守选择)'
    ).toEqual([])
    expect(
      scanSources([{ path: 'b.html', text: '<!-- 未闭合:中文\n' }]).map((v) => v.line),
      '未闭合 HTML 注释:不猜 → 保留为文本 → 多报'
    ).toEqual([1])
  })

  it('模板的 `${...}` 按代码处理:嵌套模板里的注释被剥离、外层模板文案仍保留', () => {
    const text = [
      'const S = `${a ? `x${b /* 嵌套模板表达式里的注释 */}` : "y"}`',
      "const T = '嵌套模板旁边的文案'"
    ].join('\n')
    const violations = scanSources([{ path: 'src/main/nested.ts', text }])
    expect(violations.map((violation) => violation.line)).toEqual([2])
  })

  it('注释剥离保持行号:块注释与字符串里的换行都不许吃掉行号', () => {
    const padding = Array.from(
      { length: 30 },
      (_value, index) => `const v${index} = ${index}`
    ).join('\n')
    const text = [
      padding,
      '/* 块注释',
      '   跨了多行',
      '   也必须保留换行 */',
      'const tpl = `multi',
      '   line ${1 + 1} text`',
      "const last = '中文文案'"
    ].join('\n')
    const violations = scanSources([{ path: 'src/renderer/src/x.ts', text }])
    expect(violations).toHaveLength(1)
    expect(violations[0]?.line).toBe(36)
  })

  it('\\uXXXX 转义写法的中文同样被检出', () => {
    const synthetic: SourceFile[] = [
      { path: 'esc.ts', text: "const a = '\\u786c\\u4e2d\\u6587'\n" },
      { path: 'braced.ts', text: "const b = '\\u{4e2d}\\u{6587}'\n" },
      { path: 'latin.ts', text: "const c = '\\u0041\\u0062'\n" }
    ]
    expect(scanSources(synthetic).map((violation) => violation.path)).toEqual([
      'esc.ts',
      'braced.ts'
    ])
  })

  it('MIGRATED 清单与独立副本保持一致，避免缩小检查范围', () => {
    expect([...MIGRATED].sort()).toEqual([...MIGRATED_PIN].sort())
    for (const name of MIGRATED) {
      expect(existsSync(migratedPath(name)), `${name} 已不在磁盘上,请修正 MIGRATED 清单`).toBe(true)
    }
  })

  it('PENDING 为空且与独立副本保持一致', () => {
    expect([...PENDING]).toEqual([...PENDING_PIN])
    // 当前为空:任何“先放过一个文件”的登记都要同时改 PENDING_PIN 并在旁边写明理由
    expect(PENDING).toEqual([])
    for (const path of PENDING) {
      expect(existsSync(join(process.cwd(), path)), `${path} 已不在磁盘上,请从 PENDING 移除`).toBe(
        true
      )
    }
  })

  it('豁免仅限语言选择器与 console.* 实参', () => {
    expect(ALLOWED_LITERALS).toHaveLength(1)
    expect(NON_RENDERER_EXEMPTIONS.map((entry) => entry.kind)).toEqual(['console-args'])
    // 删掉这条规则会让主进程日志集体违规,所以它不可能被悄悄关掉而不被发现
    expect(LOG_SINK_ENABLED).toBe(true)
  })

  it('仅排除文案目录，且排除清单与独立副本保持一致', () => {
    expect([...SOURCE_EXCLUSIONS]).toEqual([...SOURCE_EXCLUSIONS_PIN])
    expect(SOURCE_EXCLUSIONS, '排除面只允许文案目录这一条(新增排除=新增暗门)').toEqual([
      'src/shared/i18n/messages.ts'
    ])
    for (const path of SOURCE_EXCLUSIONS) {
      expect(existsSync(join(process.cwd(), path)), `${path} 已不在磁盘上,请修正排除面`).toBe(true)
    }
  })

  it('文案目录覆盖设置页与托盘所需的键(缺键会在运行时显示 key)', () => {
    const required = [
      'settings.title',
      'settings.language',
      'settings.theme',
      'settings.tray',
      'settings.autoStart',
      'settings.notifications',
      'settings.dataDir',
      'settings.clearCredentials',
      'settings.saved',
      'tray.show',
      'tray.quit',
      'tray.status'
    ]
    const missing = required.filter((key) => !MESSAGE_KEYS.includes(key as never))
    expect(missing).toEqual([])
  })

  it('主线使用的 key 确实存在于文案目录(缺键会在界面显示原始 key)', () => {
    // 只做「目录 → 存在性」方向:反向的「死键」检测需要扫描全部源码字符串，
    const required = [
      'settings.saveFailed',
      'settings.cleared',
      'notify.connected',
      'notify.error',
      'detail.openViewFailed',
      'tray.show',
      'tray.quit',
      'tray.status'
    ]
    const missing = required.filter((key) => !MESSAGE_KEYS.includes(key as never))
    expect(missing).toEqual([])
  })

  it('托盘状态行的插值参数两种语言都有', () => {
    expect(MESSAGES['tray.status'].zh).toContain('{count}')
    expect(MESSAGES['tray.status'].en).toContain('{count}')
  })
})
