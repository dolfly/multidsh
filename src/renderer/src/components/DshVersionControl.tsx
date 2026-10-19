import type { ReactNode } from 'react'
import { Icon } from '../lib/icons'
import { PHASE_KEYS, REASON_KEYS } from '../lib/version-phases'
import { useAppStore } from '../store'
import type { DshVersionControl } from './useDshVersionControl'

/**
 * 实例详情运行环境卡片中的 dsh 版本管理界面：
 * 「检查更新」在下方操作行，检测结果、升级与进度在卡片正文，两处共用 useDshVersionControl 的状态。
 */
export function DshVersionCheckButton({
  control
}: {
  control: DshVersionControl | null
}): ReactNode {
  const t = useAppStore((state) => state.t)
  if (control === null) return null
  return (
    <button
      className="btn btn-secondary btn-sm"
      onClick={() => void control.runCheck()}
      disabled={control.checking || control.active}
      data-testid="check-version-btn"
    >
      <Icon name="sync" />
      {control.checking ? t('detail.version.checking') : t('detail.version.check')}
    </button>
  )
}

/** 卡片正文里的版本结果区：可升级时先给升级按钮，随后是结果、失败重试与升级进度。 */
export function DshVersionPanel({ control }: { control: DshVersionControl | null }): ReactNode {
  const t = useAppStore((state) => state.t)
  if (control === null) return null
  const { versionCheck, checkError, upgradeFail, progress, active } = control
  // 尚无可展示内容时不占位，避免在操作行之上多出一段空隙。
  if (versionCheck === null && checkError === null && upgradeFail === null && progress === null) {
    return null
  }

  const foundText =
    versionCheck !== null
      ? t('detail.version.found', {
          latest: versionCheck.latest,
          current: versionCheck.current ?? '—'
        })
      : ''

  return (
    <div className="dsh-version-control mt12" data-testid="version-manage">
      {/*
        可升级且检测到新版才给出升级主按钮；按钮右侧同一行显示状态文字：未升级时为「发现新版本」
        检测结果，升级中为阶段文字（检查中 / 下载中 / 安装中）。详情日志长短不一会让卡片忽长忽短，
        这里只显示阶段，逐条下载/安装日志改到实例底部信息栏查看；npm 不提供可用的总量，不画进度条。
      */}
      {((versionCheck?.canUpgrade === true && versionCheck.hasUpdate) ||
        (progress !== null &&
          (progress.phase === 'checking' ||
            progress.phase === 'downloading' ||
            progress.phase === 'installing'))) && (
        <div className="dsh-version-control__row">
          {versionCheck?.canUpgrade === true && versionCheck.hasUpdate && (
            <button
              className="btn btn-primary btn-sm"
              onClick={() => void control.runUpgrade()}
              disabled={active}
              data-testid="upgrade-btn"
            >
              <Icon name="refresh" />
              {t('detail.version.upgrade')}
            </button>
          )}
          {versionCheck?.canUpgrade === true &&
            versionCheck.hasUpdate &&
            checkError === null &&
            !active && (
              <p className="meta" data-testid="version-check-result">
                {foundText}
              </p>
            )}
          {progress !== null &&
            (progress.phase === 'checking' ||
              progress.phase === 'downloading' ||
              progress.phase === 'installing') && (
              <p className="meta" data-testid="upgrade-progress">
                {t(PHASE_KEYS[progress.phase])}
              </p>
            )}
        </div>
      )}

      {/* 检测结果（非可升级新版的其余情况）：已是最新，或不可升级给原因、有新版时一并展示。 */}
      {versionCheck !== null &&
        checkError === null &&
        !active &&
        !(versionCheck.canUpgrade && versionCheck.hasUpdate) && (
          <p className="meta" data-testid="version-check-result">
            {versionCheck.canUpgrade ? (
              t('detail.version.upToDate')
            ) : (
              <>
                {versionCheck.hasUpdate && <>{foundText} · </>}
                <span className="dsh-version-control__reason">
                  {t(REASON_KEYS[versionCheck.reason ?? 'not-local'])}
                </span>
              </>
            )}
          </p>
        )}

      {/* 检查失败：错误 + 重试。 */}
      {checkError !== null && !active && (
        <div className="mt8" data-testid="version-check-error">
          <p className="meta err-text">{t('detail.version.checkFailed', { msg: checkError })}</p>
          <button
            className="btn btn-secondary btn-sm mt8"
            onClick={() => void control.runCheck()}
            data-testid="check-retry-btn"
          >
            {t('detail.version.retry')}
          </button>
        </div>
      )}

      {/* 完成：阶段文字 + 新版本号（版本行同时刷新）。 */}
      {progress !== null && progress.phase === 'done' && (
        <p className="meta mt8" data-testid="upgrade-done">
          {t('detail.version.phase.done')}
          {progress.version ? ` v${progress.version}` : ''}
        </p>
      )}

      {/* 失败：错误 + 重试；隔离目录保留旧版，可直接重跑升级。 */}
      {!active && upgradeFail !== null && (
        <div className="mt8" data-testid="upgrade-error">
          <p className="meta err-text">{t('detail.version.upgradeFailed', { msg: upgradeFail })}</p>
          <button
            className="btn btn-secondary btn-sm mt8"
            onClick={() => void control.runUpgrade()}
            data-testid="upgrade-retry-btn"
          >
            {t('detail.version.retry')}
          </button>
        </div>
      )}
    </div>
  )
}
