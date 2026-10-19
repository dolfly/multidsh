/**
 * 插件改动的 HMR 判定与生效口径（纯函数）。
 *
 * 与 dsh 的 `change()` 同口径：有 HMR 即 applied，仅在 reconcile 报出 restartReason 时才
 * 要求重启。判定不出时按「无 HMR」保守处理（宁可提示重启，也不谎称已生效）。
 */

/** dsh 语义下的生效结果：`applied` 已热生效；`restart-required` 需重启 Host。 */
export type PluginApplication = 'applied' | 'restart-required'

/** 含 web-app bundle 的 profile 才有 HMR 服务（headless/SDK/ACP 显式关闭）。 */
const WEB_APP_BUNDLE = '@deepseek-ai/dsh-web-app'

/**
 * 运行中的 Host 是否具备 HMR（决定改动能否热生效）。
 *
 * 与 dsh 的 `change()` 同口径：`ownerContext.get('hmr') !== undefined ? applied : restart-required`。
 * hmr 服务由 base bundle 提供、仅在有 profileContext 时启用，headless/SDK/ACP 在自己的 patch 里
 * 显式关闭。这里按「profile 名或加载清单里出现 web-app」判定；判定不出时按「无 HMR」保守处理
 * （宁可提示重启，也不谎称已生效）。
 */
export function profileHasHmr(profile: string, bundles: readonly string[] | null): boolean {
  if (profile === 'web') return true
  return bundles !== null && bundles.includes(WEB_APP_BUNDLE)
}

/**
 * 生效口径，与 dsh 一致（dsh-plugin-manager 的 change()：有 HMR 即 applied，
 * 仅在 reconcile 报出 restartReason 时才要求重启）。替换/升级已装包同样热生效——
 * dsh-hmr 按磁盘身份（inode/size/mtime）判定模块 stale 并热重载新模块代，
 * 没有「替换已装包必须重启」的特例。
 */
export function defaultApplication(hmr: boolean): PluginApplication {
  return hmr ? 'applied' : 'restart-required'
}
