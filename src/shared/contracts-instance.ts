/**
 * 实例模型：枚举、基础字段、传输变体、创建输入、更新补丁与注册表文件 schema。
 *
 * 本模块不 import electron；主进程、preload、渲染进程和测试共享这些模型与 Zod schema。
 * `transport` 是判别联合的判别字段。
 */
import { z } from 'zod'
import { tryParseEndpoint } from './endpoint'
import { LAUNCHERS } from './local-launch'
import { isValidSshHost } from './contracts-util'

// ===== 枚举 =====

export const TRANSPORTS = ['local', 'ssh', 'http'] as const
export type Transport = (typeof TRANSPORTS)[number]

/**
 * 用户显式选择的认证意图；`auto` 为默认 —— 连接建立后由认证层探测决定有效模式
 * （none / gateway / browser-auth）。browser-auth 只可能是探测产物，
 * 不存在于注册表记录中。
 */
export const AUTH_MODES = ['auto', 'none', 'gateway'] as const
export type AuthMode = (typeof AUTH_MODES)[number]

// ===== 基础字段 =====

const PORT_SCHEMA = z
  .number('端口必须是数字')
  .int('端口必须是整数')
  .min(1, '端口最小 1')
  .max(65535, '端口最大 65535')

/**
 * SSH 主机：主机名、别名、IPv4、裸或方括号 IPv6，以及带端口的组合形式。
 * 组合形式由 instance-store 拆分为独立的 host 和 port 字段。
 * 不允许空白、`/`、`@`（userinfo 属于 username 字段，不内嵌主机）。
 */
const SSH_HOST_SCHEMA = z
  .string()
  .trim()
  .min(1, 'SSH 主机不能为空')
  .max(255, 'SSH 主机最长 255 字符')
  .regex(/^[A-Za-z0-9._\-:[\]]+$/, 'SSH 主机含非法字符（不允许空白 / 斜杠 / @）')
  // host 是 ssh 的位置参数:以 '-' 开头会被当作选项解析(argv 选项注入面),
  // 在边界直接拒绝；`-oProxyCommand=` 之类因字符集不含 '=' 本就被拒。
  .refine((value) => !value.startsWith('-'), 'SSH 主机不能以 - 开头')
  .refine(isValidSshHost, 'host[:port] 形态的端口必须在 1–65535，或主机名不含冒号')

/** 配置档案：首字符必须是字母数字，其余允许字母数字与 `.` `_` `/` `-`。 */
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

/**
 * dsh 版本号允许的字符集：数字、字母与 `.+_-`（覆盖 `0.1.5-rc.2`、`0.1.6+build` 等）。
 * 单一真源放在 shared —— 安装器（拼接隔离目录名，防路径穿越）与注册表 schema 边界共用它，
 * 使非法版本在写入时即被拒，而非等到使用时。
 */
export const DSH_VERSION_PATTERN = /^[0-9A-Za-z.+_-]+$/

/** 注册表里的 dshVersion 校验：允许为空/省略；非空时必须匹配版本字符集。 */
const DSH_VERSION_SCHEMA = z.string().trim().max(64).regex(DSH_VERSION_PATTERN, '版本号含非法字符')

/**
 * 配置档案的形态校验（内部 trim）：匹配 `PROFILE_PATTERN` 且不含 `..` 段。
 * 创建向导与编辑对话框在提交前自查，`SAFE_PROFILE_SCHEMA` 在 IPC 边界再校一次。
 */
export function isValidProfile(value: string): boolean {
  const profile = value.trim()
  return PROFILE_PATTERN.test(profile) && !profile.split('/').includes('..')
}

const SAFE_PROFILE_SCHEMA = z
  .string()
  .trim()
  .min(1, '配置档案不能为空')
  .max(128, '配置档案最长 128 字符')
  .regex(PROFILE_PATTERN, '配置档案只能是相对路径，且不能以 - 开头')
  .refine((value) => !value.split('/').includes('..'), '配置档案不能包含 ..')

const instanceBaseFields = {
  id: z.uuid(),
  name: z.string().trim().min(1, '名称不能为空').max(64, '名称最长 64 字符'),
  authMode: z.enum(AUTH_MODES),
  /** 备注可为空：null / 省略均表示无备注（补丁层用 null 显式清空） */
  notes: z.string().trim().max(2000, '备注最长 2000 字符').nullable().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
}

// ===== 三种变体（判别联合） =====

export const LocalInstanceSchema = z.object({
  ...instanceBaseFields,
  transport: z.literal('local'),
  /** 已安装的 dsh 版本；null = 未安装。 */
  dshVersion: DSH_VERSION_SCHEMA.nullable().default(null),
  /** 已分配的监听端口；null = 未分配。 */
  port: PORT_SCHEMA.nullable().default(null),
  /** 实例配置文件（相对 DSH_HOME） */
  profile: SAFE_PROFILE_SCHEMA.nullable().default(null),
  /** 可选的 dsh/dush/duush 启动器；null = 默认 dsh。参数由 Hub 固定构造。 */
  launcher: z.enum(LAUNCHERS).nullable().default(null),
  /** true 时复用用户的 ~/.dsh，而非 Hub 的隔离实例目录。 */
  useDefaultSpace: z.boolean().default(false),
  /** 最近一次启动的命令行；启动成功后由状态事件回写。null = 尚未由 Hub 启动过。 */
  runCommand: z.string().trim().max(2048).nullable().default(null),
  /** 应用启动时自动拉起 */
  autoStart: z.boolean().default(false)
})

export const SshInstanceSchema = z.object({
  ...instanceBaseFields,
  transport: z.literal('ssh'),
  host: SSH_HOST_SCHEMA,
  /** SSH 连接端口 */
  port: PORT_SCHEMA.default(22),
  username: z.string().trim().min(1, 'SSH 用户名不能为空').max(128, 'SSH 用户名最长 128 字符'),
  /** 远端 dsh 监听端口（隧道目标，默认 dsh web 惯例端口） */
  remotePort: PORT_SCHEMA.default(3080),
  /** 隧道本地端口；null = 未分配。 */
  localPort: PORT_SCHEMA.nullable().default(null),
  /**
   * 显式私钥路径；null = 默认，优先使用 agent。
   *
   * 这是唯一由渲染层提供、会到达主进程文件系统的路径（作为 `ssh -i <path>` 的参数），
   * 是「IPC 不接受渲染层路径」规则下有意的有界例外：SSH 语义要求用户指名密钥文件，
   * 且它只作为 `-i` 的独立 argv 值传入、不经 shell、不构成位置参数（无 `-o` 选项注入面），
   * ssh 至多尝试把它当密钥加载。仅做长度约束。
   */
  identityFile: z.string().trim().max(512).nullable().default(null)
})

export const HttpInstanceSchema = z.object({
  ...instanceBaseFields,
  transport: z.literal('http'),
  /** HTTP 直连端点。存归一化 baseUrl；userinfo、查询串和锚点由 parseEndpointUrl 拒绝。 */
  endpointUrl: z
    .string()
    .trim()
    .max(2048)
    .refine(
      (value) => tryParseEndpoint(value).ok,
      '端点 URL 无法解析（仅支持 http/https，禁止内嵌凭据 / 查询串 / 锚点）'
    )
})

export const InstanceRecordSchema = z.discriminatedUnion('transport', [
  LocalInstanceSchema,
  SshInstanceSchema,
  HttpInstanceSchema
])
export type InstanceRecord = z.infer<typeof InstanceRecordSchema>
export type LocalInstance = Extract<InstanceRecord, { transport: 'local' }>
export type SshInstance = Extract<InstanceRecord, { transport: 'ssh' }>
export type HttpInstance = Extract<InstanceRecord, { transport: 'http' }>

// ===== 创建输入（IPC 边界，.strict()：未知字段一律拒绝） =====

const createBaseFields = {
  name: z.string().trim().min(1, '名称不能为空').max(64, '名称最长 64 字符'),
  authMode: z.enum(AUTH_MODES).default('auto'),
  notes: z.string().trim().max(2000).nullable().optional()
}

export const CreateInstanceInputSchema = z.discriminatedUnion('transport', [
  z
    .object({
      ...createBaseFields,
      transport: z.literal('local'),
      dshVersion: DSH_VERSION_SCHEMA.optional(),
      port: PORT_SCHEMA.optional(),
      profile: SAFE_PROFILE_SCHEMA.optional(),
      launcher: z.enum(LAUNCHERS).optional(),
      useDefaultSpace: z.boolean().optional(),
      /** 创建后接管检测到的外部 dsh web；这些瞬时输入不写入注册表。 */
      useExistingExternal: z.boolean().optional(),
      externalPid: z.number().int().positive().optional(),
      externalAccess: z.string().trim().min(1).max(4096).optional(),
      autoStart: z.boolean().optional(),
      /** 复用 Hub 已有隔离空间；主进程会验证它确实存在且没有已关联实例。 */
      existingSpaceId: z.uuid().optional()
    })
    .strict(),
  z
    .object({
      ...createBaseFields,
      transport: z.literal('ssh'),
      host: SSH_HOST_SCHEMA,
      port: PORT_SCHEMA.optional(),
      username: z.string().trim().min(1, 'SSH 用户名不能为空').max(128),
      remotePort: PORT_SCHEMA.optional(),
      localPort: PORT_SCHEMA.optional(),
      identityFile: z.string().trim().max(512).optional()
    })
    .strict(),
  z
    .object({
      ...createBaseFields,
      transport: z.literal('http'),
      endpointUrl: z
        .string()
        .trim()
        .max(2048)
        .refine(
          (value) => tryParseEndpoint(value).ok,
          '端点 URL 无法解析（仅支持 http/https，禁止内嵌凭据 / 查询串 / 锚点）'
        )
    })
    .strict()
])
/**
 * 调用方（渲染层 / preload / 测试）传入的创建参数：默认值字段可省略，
 * 因此用 z.input 而非 z.infer（后者是已填默认值的输出类型，会把 authMode 变成必填）。
 */
export type CreateInstanceInput = z.input<typeof CreateInstanceInputSchema>
/** 经 schema 解析后的规范形态（store 内部使用） */
export type CreateInstanceParams = z.output<typeof CreateInstanceInputSchema>

/** 密钥预览输入（向导里的草稿，未必已入库） */
export const SshKeyPreviewInputSchema = z
  .object({
    host: SSH_HOST_SCHEMA,
    port: PORT_SCHEMA.default(22),
    username: z.string().trim().min(1, 'SSH 用户名不能为空').max(128),
    identityFile: z.string().trim().max(512).nullable().optional()
  })
  .strict()
export type SshKeyPreviewInput = z.input<typeof SshKeyPreviewInputSchema>

// ===== 更新补丁（transport 不可变：改传输形态 = 删除重建） =====

export const PatchInstanceSchema = z
  .object({
    name: z.string().trim().min(1, '名称不能为空').max(64).optional(),
    authMode: z.enum(AUTH_MODES).optional(),
    /** null 用于清空备注 */
    notes: z.string().trim().max(2000).nullable().optional(),
    // —— local ——
    dshVersion: DSH_VERSION_SCHEMA.nullable().optional(),
    port: PORT_SCHEMA.nullable().optional(),
    profile: SAFE_PROFILE_SCHEMA.nullable().optional(),
    launcher: z.enum(LAUNCHERS).nullable().optional(),
    useDefaultSpace: z.boolean().optional(),
    runCommand: z.string().trim().max(2048).nullable().optional(),
    autoStart: z.boolean().optional(),
    // —— ssh ——
    host: SSH_HOST_SCHEMA.optional(),
    username: z.string().trim().min(1).max(128).optional(),
    remotePort: PORT_SCHEMA.optional(),
    localPort: PORT_SCHEMA.nullable().optional(),
    identityFile: z.string().trim().max(512).nullable().optional(),
    // —— http ——
    endpointUrl: z
      .string()
      .trim()
      .max(2048)
      .refine(
        (value) => tryParseEndpoint(value).ok,
        '端点 URL 无法解析（仅支持 http/https，禁止内嵌凭据 / 查询串 / 锚点）'
      )
      .optional()
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, '补丁不能为空')
export type PatchInstanceInput = z.input<typeof PatchInstanceSchema>
/** 经 schema 解析后的补丁（store 内部使用） */
export type PatchInstanceParams = z.output<typeof PatchInstanceSchema>

// ===== 注册表文件与版本迁移 =====

/**
 * 注册表 schema 版本。
 * - v1：初始形态。
 * - v2：`SSH_HOST_SCHEMA` 收紧（方括号只允许包裹 IPv6 字面量）与 `dshVersion` 收紧
 *   （必须匹配 `DSH_VERSION_PATTERN`）后，旧版可能写入过 `[plainhost]` / 含空格的版本号；
 *   v1→v2 迁移把这类历史值归一化，避免整表因单条不合法被隔离（见 registry 迁移器）。
 */
export const REGISTRY_SCHEMA_VERSION = 2

export const RegistryFileSchema = z.object({
  schemaVersion: z.number('schemaVersion 必须是数字').int().min(1),
  instances: z.array(InstanceRecordSchema)
})
export type RegistryFile = z.infer<typeof RegistryFileSchema>

export type RegistryMigration = (file: unknown) => unknown
