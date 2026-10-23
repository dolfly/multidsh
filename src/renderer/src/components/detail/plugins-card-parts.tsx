import type { ReactNode } from 'react'
import type { PluginInfo } from '@shared/contracts'
import type { Translator } from '@shared/i18n'
import { Icon } from '../../lib/icons'
import { fmtLogTime } from '../../lib/format'
import { CopyableValue } from '../CopyableValue'
import { HoverTip } from '../InfoTip'
import { Modal } from '../Modal'
import Switch from '../Switch'
import {
  canOfferUpgrade,
  pluginSourceKey,
  showsIncompatibleWarning,
  showsUnknownCompatibility,
  showsUpToDate,
  type PluginCheckState
} from '../../lib/plugins-card-state'

/** 一行插件的可变操作态：检查/升级/卸载进行中标记。 */
export interface RowBusy {
  upgrading: boolean
  removing: boolean
  toggling: boolean
}

/** 卸载二次确认目标。 */
export interface RemoveTarget {
  name: string
}

/** 单个插件行：图标 + 名称/版本/来源 + 操作列 + 手风琴详情。 */
export function PluginRow(props: {
  t: Translator
  plugin: PluginInfo
  expanded: boolean
  onToggle: () => void
  check: PluginCheckState
  busy: RowBusy
  /** 批量（系统）检查进行中：锁定单行检查按钮，同一时刻只让系统检查在跑。 */
  locked: boolean
  onCheck: () => void
  onUpgrade: (version: string) => void
  onToggleEnabled: (enabled: boolean) => void
  onRemove: () => void
  onOpenLink: (url: string | null) => void
}): ReactNode {
  const {
    t,
    plugin,
    expanded,
    onToggle,
    check,
    busy,
    locked,
    onCheck,
    onUpgrade,
    onToggleEnabled,
    onRemove,
    onOpenLink
  } = props
  const disabled = plugin.enabled === false
  // 不兼容/无法判定共用同一组参数：标题与正文复用一次计算，避免两处 t() 调用漂移。
  const incompatibleText =
    check.result === null
      ? ''
      : t(
          showsUnknownCompatibility(check)
            ? 'detail.plugin.incompatibleUnknown'
            : 'detail.plugin.incompatible',
          {
            latest: check.result.latest,
            peer: check.result.dshPeer ?? '—',
            current: check.result.dshVersion ?? '—'
          }
        )
  return (
    <li
      className={disabled ? 'plugin-row plugin-row--disabled' : 'plugin-row'}
      data-testid={`plugin-row-${plugin.name}`}
    >
      <div className="plugin-row-head">
        <button
          className="plugin-expand"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={plugin.name}
          data-testid={`plugin-expand-${plugin.name}`}
        >
          {plugin.iconDataUri ? (
            <img className="plugin-icon" src={plugin.iconDataUri} alt="" width={20} height={20} />
          ) : (
            <span className="plugin-icon plugin-icon-fallback" aria-hidden="true">
              <Icon name="hub" size={16} />
            </span>
          )}
          {/* 有本地化名称则名称为主、包名作二级标题跟随；无名称则包名作主标题。 */}
          <span className="plugin-title-group">
            <span className="plugin-name">{plugin.title ?? plugin.name}</span>
            {plugin.title && <span className="plugin-pkgname num">{plugin.name}</span>}
          </span>
          <span className="badge num">{plugin.version}</span>
          <span className="plugin-source">{t(pluginSourceKey(plugin.installSource))}</span>
          {disabled && (
            <span
              className="badge plugin-disabled-badge"
              data-testid={`plugin-disabled-${plugin.name}`}
            >
              {t('detail.plugin.disabled')}
            </span>
          )}
        </button>
        <div className="row plugin-actions" style={{ gap: 8 }}>
          {/* 检查结果内联在操作行最左，不换行占整行：已最新 / 不兼容警告 / 检查失败。 */}
          {showsUpToDate(check) && (
            <span
              className="meta plugin-status-inline"
              data-testid={`plugin-uptodate-${plugin.name}`}
            >
              {t('detail.plugin.uptodate')}
            </span>
          )}
          {showsIncompatibleWarning(check) && check.result !== null && (
            // 行内宽度有限必然截断：完整说明由 hover/聚焦气泡给出（原 title 由气泡取代）。
            <HoverTip text={incompatibleText}>
              <span
                className="meta err-text plugin-status-inline"
                data-testid={`plugin-incompatible-${plugin.name}`}
              >
                {incompatibleText}
              </span>
            </HoverTip>
          )}
          {check.status === 'error' && check.error !== null && (
            <HoverTip text={t('detail.plugin.checkFailed', { msg: check.error })}>
              <span
                className="meta err-text plugin-status-inline"
                data-testid={`plugin-check-error-${plugin.name}`}
              >
                {t('detail.plugin.checkFailed', { msg: check.error })}
              </span>
            </HoverTip>
          )}
          {/* 启用/禁用开关：开=已加载。纯 client 插件不由清单控制，开关置灰并说明原因。 */}
          <Switch
            checked={!disabled}
            onChange={(next) => onToggleEnabled(next)}
            disabled={plugin.enabled === null || busy.toggling}
            title={
              plugin.enabled === null
                ? t('detail.plugin.cannotDisable')
                : t('detail.plugin.enableToggle')
            }
            ariaLabel={t('detail.plugin.enableToggle')}
            testId={`plugin-toggle-${plugin.name}`}
          />
          <button
            className="btn btn-secondary btn-sm plugin-check-btn"
            onClick={onCheck}
            disabled={check.status === 'checking' || locked}
            title={locked ? t('detail.plugin.checkLocked') : undefined}
            data-testid={`plugin-check-${plugin.name}`}
          >
            <Icon name="sync" />
            {/* 两个候选文案叠放在同一 grid 单元，宽度取最大值：切「检查中…/检查升级」按钮不跳动，
                中英文各自按各自的最长文案自适应。 */}
            <span className="btn-swap">
              <span className="btn-swap-cell" data-active={check.status !== 'checking'}>
                {t('detail.plugin.checkUpdate')}
              </span>
              <span className="btn-swap-cell" data-active={check.status === 'checking'}>
                {t('detail.plugin.checking')}
              </span>
            </span>
          </button>
          {canOfferUpgrade(check) && check.result !== null && (
            <button
              className="btn btn-primary btn-sm"
              onClick={() => onUpgrade(check.result!.latest)}
              disabled={busy.upgrading}
              data-testid={`plugin-upgrade-${plugin.name}`}
            >
              <Icon name="refresh" />
              {busy.upgrading
                ? t('detail.plugin.upgrading')
                : t('detail.plugin.upgradeTo', { version: check.result.latest })}
            </button>
          )}
          <button
            className="btn btn-danger btn-sm btn-icon plugin-remove-btn"
            onClick={onRemove}
            disabled={busy.removing}
            aria-label={t('detail.plugin.remove')}
            title={busy.removing ? t('detail.plugin.removing') : t('detail.plugin.remove')}
            data-testid={`plugin-remove-${plugin.name}`}
          >
            <Icon name="trash" />
          </button>
        </div>
      </div>

      {expanded && <PluginDetail t={t} plugin={plugin} check={check} onOpenLink={onOpenLink} />}
    </li>
  )
}

/** 手风琴展开的插件详情。 */
function PluginDetail(props: {
  t: Translator
  plugin: PluginInfo
  check: PluginCheckState
  onOpenLink: (url: string | null) => void
}): ReactNode {
  const { t, plugin, check, onOpenLink } = props
  // 发布时间取已装版本的快照：刚检查完用本次结果，否则用主进程持久化并回填到列表的那条。
  const publishedAt = check.result?.publishedAt ?? plugin.publishedAt
  return (
    <dl className="kv plugin-detail" data-testid={`plugin-detail-${plugin.name}`}>
      {/* 包名行：标题里只是展示，详情给可复制的正式名称（安装/检索都用它）。 */}
      <dt>{t('detail.plugin.field.name')}</dt>
      <dd>
        <CopyableValue t={t} value={plugin.name} testId={`plugin-name-${plugin.name}`} />
      </dd>
      {plugin.description && (
        <>
          <dt>{t('detail.plugin.field.description')}</dt>
          <dd>{plugin.description}</dd>
        </>
      )}
      {plugin.author && (
        <>
          <dt>{t('detail.plugin.field.author')}</dt>
          <dd>{plugin.author}</dd>
        </>
      )}
      {plugin.license && (
        <>
          <dt>{t('detail.plugin.field.license')}</dt>
          <dd>{plugin.license}</dd>
        </>
      )}
      {plugin.githubUrl && (
        <>
          <dt>{t('detail.plugin.field.github')}</dt>
          <dd>
            <button className="link-btn" onClick={() => onOpenLink(plugin.githubUrl)}>
              {plugin.githubUrl}
            </button>
          </dd>
        </>
      )}
      {plugin.npmUrl && (
        <>
          <dt>{t('detail.plugin.field.npm')}</dt>
          <dd>
            <button className="link-btn" onClick={() => onOpenLink(plugin.npmUrl)}>
              {plugin.npmUrl}
            </button>
          </dd>
        </>
      )}
      <dt>{t('detail.plugin.field.published')}</dt>
      <dd className="num">
        {publishedAt !== null ? fmtLogTime(publishedAt) : t('detail.plugin.publishedUnknown')}
      </dd>
      <dt>{t('detail.plugin.field.compat')}</dt>
      <dd className="num">
        dsh {plugin.dshPeer ?? '—'}
        {plugin.nodeEngine ? ` · node ${plugin.nodeEngine}` : ''}
      </dd>
      <dt>{t('detail.plugin.field.deps')}</dt>
      <dd>
        {plugin.dependencies.length > 0
          ? plugin.dependencies.join(', ')
          : t('detail.plugin.depsNone')}
      </dd>
    </dl>
  )
}

/** 卸载二次确认弹窗；含 host 半时附带重启提示。 */
export function RemovePluginModal(props: {
  t: Translator
  target: RemoveTarget
  onClose: () => void
  onConfirm: () => void
}): ReactNode {
  const { t, target, onClose, onConfirm } = props
  return (
    <Modal
      title={t('detail.plugin.removeConfirmTitle')}
      onClose={onClose}
      closeLabel={t('common.close')}
      testId="plugin-remove-confirm"
      footer={
        <>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn btn-danger btn-sm"
            onClick={onConfirm}
            data-testid="plugin-remove-confirm-btn"
          >
            {t('detail.plugin.remove')}
          </button>
        </>
      }
    >
      <p className="meta">{t('detail.plugin.removeConfirmBody', { name: target.name })}</p>
    </Modal>
  )
}

/** host 半改动后的重启提醒弹窗。 */
export function RestartPromptModal(props: {
  t: Translator
  name: string
  onClose: () => void
  onConfirm: () => void
}): ReactNode {
  const { t, name, onClose, onConfirm } = props
  return (
    <Modal
      title={t('detail.plugin.restartTitle')}
      onClose={onClose}
      closeLabel={t('common.close')}
      testId="plugin-restart-prompt"
      footer={
        <>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>
            {t('detail.plugin.restartLater')}
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={onConfirm}
            data-testid="plugin-restart-now-btn"
          >
            {t('detail.plugin.restartNow')}
          </button>
        </>
      }
    >
      <p className="meta">{t('detail.plugin.restartBody', { name })}</p>
    </Modal>
  )
}
