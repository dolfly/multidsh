import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { AppInfo } from '@shared/bridge'
import { Icon } from '../lib/icons'
import { useAppStore } from '../store'
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
  /** 已复制的数据列标识；null = 无。反馈只做就地展示，不占版面、不弹 toast。 */
  const [copiedField, setCopiedField] = useState<string | null>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false
    void BRIDGE?.getInfo().then((result) => {
      if (!cancelled && result.ok) setInfo(result.value)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(
    () => () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current)
    },
    []
  )

  /** 点击复制数据列的展示值；剪贴板不可用时不切换反馈，避免显示假的「已复制」。 */
  const copyCell = (field: string, value: string): void => {
    void navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopiedField(field)
        if (copyTimer.current !== null) clearTimeout(copyTimer.current)
        copyTimer.current = setTimeout(() => setCopiedField(null), 1600)
      })
      .catch(() => undefined)
  }

  /** 数据列单元：值 + hover/聚焦露出的复制图标，复制成功后短暂变为「已复制」。 */
  const copyCellButton = (field: string, value: string): ReactNode => {
    const copied = copiedField === field
    return (
      <button
        type="button"
        className="about-copy"
        title={t('about.copy')}
        data-copied={copied ? 'true' : undefined}
        onClick={() => copyCell(field, value)}
      >
        <span className="about-copy-value">{value}</span>
        <span className="about-copy-tail" role="status">
          {copied ? (
            <>
              <Icon name="check" size={11} /> {t('about.copied')}
            </>
          ) : (
            <Icon name="copy" size={11} />
          )}
        </span>
      </button>
    )
  }

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
              <dd data-testid="about-build-commit">{copyCellButton('build-commit', info.buildCommit)}</dd>
            </div>
            <div className="about-row">
              <dt>{t('about.buildTime')}</dt>
              <dd data-testid="about-build-time">{copyCellButton('build-time', buildTime)}</dd>
            </div>
          </dl>
        )}
        <section className="about-components">
          <h3>{t('about.components')}</h3>
          <dl>
            {components.map(([name, version]) => (
              <div key={name} className="about-row">
                <dt>{name}</dt>
                <dd data-testid={`about-${name.toLowerCase()}`}>{copyCellButton(`component-${name}`, version)}</dd>
              </div>
            ))}
          </dl>
        </section>
        <p className="about-copyright">{t('about.copyright')}</p>
      </div>
    </Modal>
  )
}
