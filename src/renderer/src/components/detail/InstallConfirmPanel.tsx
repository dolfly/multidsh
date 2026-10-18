import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { PluginInstallPlan, PluginPackageInfo } from '@shared/contracts'
import type { Translator } from '@shared/i18n'
import { Icon } from '../../lib/icons'
import { fmtLogTime } from '../../lib/format'
import { useAppStore } from '../../store'

const BRIDGE = window.dshHub

/** 更新内容与下载量的取数态：loading = 请求中；ready = 取到；none = 不适用或取不到。 */
type InfoState =
  { status: 'loading' } | { status: 'ready'; info: PluginPackageInfo } | { status: 'none' }

export interface InstallConfirmPanelProps {
  t: Translator
  /** 实例 id：确认区自己拉取该版本的更新内容与下载量，不阻塞主按钮。 */
  instanceId: string
  /** 已解析出的计划（安装第二步 / 升级目标版本的解析结果）。 */
  plan: PluginInstallPlan
  /** install = 安装第二步；upgrade = 升级二次确认；两者只差分区标题。 */
  mode: 'install' | 'upgrade'
  /** npm 来源的安装源档位文案（安装与升级都由调用方传入；省略则徽标只写 npm registry）。 */
  registryLabel?: string
  /** 不兼容风险勾选值；未勾选时调用方禁用主按钮。 */
  riskAccepted: boolean
  onRiskChange: (accepted: boolean) => void
}

/**
 * 确认区：插件名 / 版本 / 发布时间 / 近 30 天下载 / dsh 兼容五项事实，加不兼容风险勾选与更新内容。
 *
 * 插件名排在版本之前：升级弹窗不回显输入，先看清对象再读版本，避免升错插件。
 * 安装第二步与升级二次确认共用；提交按钮与「安装后启用」勾选由调用方渲染。
 * 更新内容与下载量是增强信息：主进程取不到时按「无」渲染（显示占位符），不影响提交。
 */
export default function InstallConfirmPanel(props: InstallConfirmPanelProps): ReactNode {
  const { t, instanceId, plan, mode, registryLabel, riskAccepted, onRiskChange } = props
  const toast = useAppStore((state) => state.toast)
  const [info, setInfo] = useState<InfoState>({ status: 'none' })

  const packageName = plan.packageName
  const targetVersion = plan.targetVersion

  useEffect(() => {
    const bridge = BRIDGE
    // 只有 npm 来源且解析出具体版本才有可查的更新内容与下载量：
    // github/file 与无版本直接按「无」渲染，不发请求。
    if (!bridge || plan.kind !== 'npm' || packageName === null || targetVersion === null) {
      setInfo({ status: 'none' })
      return
    }
    let cancelled = false
    setInfo({ status: 'loading' })
    void bridge.plugin.packageInfo(instanceId, packageName, targetVersion).then((result) => {
      // 计划已被替换（输入变更）或面板已卸载：迟到的结果一律丢弃。
      if (cancelled) return
      // 上游取不到不是错误：按「无更新内容、无下载量」渲染。
      setInfo(result.ok ? { status: 'ready', info: result.value } : { status: 'none' })
    })
    return () => {
      cancelled = true
    }
  }, [instanceId, plan.kind, packageName, targetVersion])

  const releaseNotes = info.status === 'ready' ? info.info.releaseNotes : null
  const downloads = info.status === 'ready' ? info.info.downloads : null
  const sourceBadge =
    plan.kind === 'npm'
      ? registryLabel === undefined
        ? t('detail.plugin.confirmSourceNpm')
        : `${t('detail.plugin.confirmSourceNpm')} · ${registryLabel}`
      : plan.kind === 'github'
        ? t('detail.plugin.confirmSourceGithub')
        : t('detail.plugin.confirmSourceFile')
  /**
   * 版本演进行：左旧右新，箭头本身表达「升级/替换」，不再配文字说明。
   * 未安装与同版本仍走单徽标 + 说明（未安装 / 版本已相符（重装））。
   */
  const installed = plan.installedVersion
  const versionEvolution = installed !== null && targetVersion !== null && installed !== targetVersion
  const installedNote =
    installed === null
      ? t('detail.plugin.confirmUninstalled')
      : installed === targetVersion
        ? t('detail.plugin.confirmInstalledSame', { version: installed })
        : null
  const compatVerdict =
    plan.compatible === true
      ? t('detail.plugin.confirmCompatOk')
      : plan.compatible === false
        ? t('detail.plugin.confirmCompatFail')
        : t('detail.plugin.confirmCompatUnknown')
  const releaseSourceBadge =
    releaseNotes === null
      ? null
      : releaseNotes.source === 'github-release'
        ? t('detail.plugin.releaseNotesSourceGithub')
        : releaseNotes.source === 'changelog'
          ? t('detail.plugin.releaseNotesSourceChangelog')
          : null
  const pageUrl = releaseNotes?.pageUrl ?? null

  const openPage = (url: string | null): void => {
    if (url === null || !BRIDGE) return
    void BRIDGE.plugin.openExternal(url).then((result) => {
      if (!result.ok) toast('err', t('detail.plugin.openLinkFailed'), result.message)
    })
  }

  return (
    <>
      <div className="card-head mt16">
        <h3>
          {t(
            mode === 'install'
              ? 'detail.plugin.confirmInstallSection'
              : 'detail.plugin.confirmUpgradeSection'
          )}
        </h3>
        <span className="badge">{sourceBadge}</span>
      </div>
      <dl className="kv">
        {/* 插件名在版本之上：npm 用包名，github/file 没有包名，用实际安装的 spec 作对象标识。 */}
        <dt>{t('detail.plugin.confirmPlugin')}</dt>
        <dd data-testid="install-confirm-name">{packageName ?? plan.installSpec}</dd>
        <dt>{t('detail.plugin.confirmVersion')}</dt>
        <dd data-testid="install-confirm-version">
          {versionEvolution ? (
            <>
              <span className="meta num">{installed}</span>
              <span className="ver-arrow">→</span>
              <span className="badge num">{targetVersion ?? plan.installSpec}</span>
            </>
          ) : (
            <>
              <span className="badge num">{targetVersion ?? plan.installSpec}</span>
              {installedNote !== null && (
                <>
                  {' '}
                  <span className="meta">{installedNote}</span>
                </>
              )}
            </>
          )}
        </dd>
        <dt>{t('detail.plugin.field.published')}</dt>
        <dd className="num" data-testid="install-confirm-published">
          {plan.publishedAt === null ? '—' : fmtLogTime(plan.publishedAt)}
        </dd>
        <dt>{t('detail.plugin.confirmDownloads')}</dt>
        <dd className="num" data-testid="install-confirm-downloads">
          {downloads === null ? '—' : downloads.count.toLocaleString()}
          {downloads !== null && (
            <>
              {' '}
              <span className="meta">{t('detail.plugin.confirmDownloadsNote')}</span>
            </>
          )}
        </dd>
        <dt>{t('detail.plugin.confirmCompat')}</dt>
        <dd className="num" data-testid="install-confirm-compat">
          {plan.dshPeer ?? '—'} · {plan.dshVersion ?? '—'} {compatVerdict}
        </dd>
      </dl>

      {/* 兼容性为 false 才是「已知风险」：要求显式勾选后才放行主按钮；无法判定（null）不要求。 */}
      {plan.compatible === false && (
        <>
          <div className="note n-warn mt12">
            <Icon name="alert" />
            <span data-testid="install-confirm-risk-note">
              {t('detail.plugin.confirmCompat')} {plan.dshPeer ?? '—'} · {plan.dshVersion ?? '—'}{' '}
              {t('detail.plugin.confirmCompatFail')}
            </span>
          </div>
          <label className="check mt12">
            <input
              type="checkbox"
              checked={riskAccepted}
              onChange={(event) => onRiskChange(event.target.checked)}
              data-testid="install-confirm-risk"
            />
            <span>{t('detail.plugin.confirmRisk')}</span>
          </label>
        </>
      )}

      <div className="card-head mt16">
        <h3>{t('detail.plugin.releaseNotesTitle')}</h3>
        <span className="row" style={{ gap: 10 }}>
          {releaseSourceBadge !== null && <span className="badge">{releaseSourceBadge}</span>}
          {pageUrl !== null && (
            <button className="link-btn" onClick={() => openPage(pageUrl)}>
              {t('detail.plugin.releaseNotesOpen')}
            </button>
          )}
        </span>
      </div>
      {info.status === 'loading' ? (
        <p className="meta">{t('detail.plugin.releaseNotesLoading')}</p>
      ) : releaseNotes !== null && releaseNotes.text !== null ? (
        <>
          {/* 正文按纯文本渲染（pre-wrap），不解析 Markdown，避免注入与新增依赖。 */}
          <p className="release-notes" data-testid="install-confirm-notes">
            {releaseNotes.text}
          </p>
          {releaseNotes.truncated && (
            <p className="meta mt8">{t('detail.plugin.releaseNotesTruncated')}</p>
          )}
        </>
      ) : (
        <p className="meta">{t('detail.plugin.releaseNotesEmpty')}</p>
      )}
    </>
  )
}
