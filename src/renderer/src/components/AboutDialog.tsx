import { useEffect, useState } from 'react'
import type { AppInfo } from '@shared/bridge'
import { useAppStore } from '../store'
import { CopyableValue } from './CopyableValue'
import { Modal } from './Modal'

const BRIDGE = window.dshHub

/** 把注入的 ISO 打包时间格式化为本地时间；'unknown'/缺失/非法值原样回落 'unknown'。 */
function formatBuildTime(iso: string | undefined): string {
  if (!iso || iso === 'unknown') return 'unknown'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? 'unknown' : date.toLocaleString()
}

/**
 * 「关于」面板：应用版本、项目主页链接与运行组件版本。
 *
 * 由独立叠加窗口（`?window=about`）承载：与宿主窗口完全重合的透明子窗口，
 * 浮在宿主窗口（含内嵌工作区）之上，打开与关闭都不改变宿主的页面路由；
 * 三种关闭途径（右上角、遮罩、Escape）都关闭本窗口。
 * 版本信息取自主进程 `app:info` 快照——渲染层拿不到的东西（Electron/Chromium/Node/V8）
 * 只有主进程能诚实回答。
 */
export default function AboutDialog() {
  const t = useAppStore((state) => state.t)
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    let cancelled = false
    void BRIDGE?.getInfo().then((result) => {
      if (!cancelled && result.ok) setInfo(result.value)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const components: Array<[string, string]> = info
    ? [
        ['Electron', info.electron],
        ['Chromium', info.chrome],
        ['Node.js', info.node],
        ['V8', info.v8]
      ]
    : []

  const buildTime = formatBuildTime(info?.buildTime)

  return (
    <Modal
      title={t('about.title')}
      onClose={() => window.close()}
      closeLabel={t('common.close')}
      testId="about-dialog"
    >
      <div className="about">
        <p className="about-version" data-testid="about-version">
          DSH Hub {info ? `v${info.appVersion}` : ''}
        </p>
        <button
          className="about-homepage"
          data-testid="about-homepage"
          onClick={() => void BRIDGE?.openHomepage()}
        >
          {t('about.homepage')} ↗
        </button>
        {info && (
          <dl className="about-build">
            <div className="about-row">
              <dt>{t('about.build')}</dt>
              <dd data-testid="about-build-commit">
                <CopyableValue t={t} value={info.buildCommit} />
              </dd>
            </div>
            <div className="about-row">
              <dt>{t('about.buildTime')}</dt>
              <dd data-testid="about-build-time">
                <CopyableValue t={t} value={buildTime} />
              </dd>
            </div>
          </dl>
        )}
        <section className="about-components">
          <h3>{t('about.components')}</h3>
          <dl>
            {components.map(([name, version]) => (
              <div key={name} className="about-row">
                <dt>{name}</dt>
                <dd data-testid={`about-${name.toLowerCase()}`}>
                  <CopyableValue t={t} value={version} />
                </dd>
              </div>
            ))}
          </dl>
        </section>
        <p className="about-copyright">{t('about.copyright')}</p>
      </div>
    </Modal>
  )
}
