import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { InstanceSummary, Transport, WorkspaceHotkeyEvent } from '@shared/contracts'
import { Icon } from '../lib/icons'
import logoUrl from '../../../../design/dsh-hub-logo.svg'
import { STATUS_INFO, TYPE_INFO, toDisplayStatus } from '../lib/format'
import { instanceSwitchIndex } from '../lib/hotkeys'
import { rendererPlatform } from '../lib/platform'
import { switchModifierKey } from '@shared/hotkeys'
import { useAppStore } from '../store'

/** 快捷键序号上限:⌘+1..9,超出上限的实例不参与切换。 */
const HOTKEY_LIMIT = 9
/** 序号角标的延迟显示窗口:按住满该时长才显示,避免快速的 ⌘B/⌘N 组合闪出角标。 */
const HOTKEY_HINT_DELAY_MS = 500

/** 侧边栏:品牌 / 搜索 / 分组 / 实例列表 / 底部操作 */
export default function Sidebar(): ReactNode {
  const t = useAppStore((state) => state.t)
  const instances = useAppStore((state) => state.instances)
  const selection = useAppStore((state) => state.selection)
  const rail = useAppStore((state) => state.rail)
  const theme = useAppStore((state) => state.theme)
  const select = useAppStore((state) => state.select)
  const openFromSidebar = useAppStore((state) => state.openFromSidebar)
  const toggleRail = useAppStore((state) => state.toggleRail)
  const toggleTheme = useAppStore((state) => state.toggleTheme)
  const setWizardOpen = useAppStore((state) => state.setWizardOpen)
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen)
  const reorderInstances = useAppStore((state) => state.reorderInstances)

  const [query, setQuery] = useState('')
  const [groupByType, setGroupByType] = useState(false)
  /** 序号角标是否显示;按住修饰键满延迟窗口后显示,松开或失焦收起。 */
  const [hotkeyHeld, setHotkeyHeld] = useState(false)
  const hoveredInstanceRef = useRef<{ element: HTMLButtonElement; name: string } | null>(null)

  // —— 拖拽排序状态 ——
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [dragPosition, setDragPosition] = useState<'top' | 'bottom'>('top')
  /** ref 实时记录放下位置，避免 onDrop 闭包读到旧 state */
  const dropTargetRef = useRef<{ id: string; position: 'top' | 'bottom' } | null>(null)
  /** 记录拖拽开始时的完整顺序，用于计算新位置 */
  const dragStartOrderRef = useRef<string[]>([])

  const showRailTooltip = (element: HTMLButtonElement, name: string): void => {
    hoveredInstanceRef.current = { element, name }
    if (!rail) return
    const rect = element.getBoundingClientRect()
    void window.dshHub?.runtime.showTooltip({
      text: name,
      x: 72,
      y: Math.round(rect.top + rect.height / 2)
    })
  }

  const hideRailTooltip = (): void => {
    hoveredInstanceRef.current = null
    void window.dshHub?.runtime.hideTooltip()
  }

  useEffect(() => {
    if (!rail || !hoveredInstanceRef.current) {
      void window.dshHub?.runtime.hideTooltip()
      return
    }
    const frame = requestAnimationFrame(() => {
      const hovered = hoveredInstanceRef.current
      if (!hovered) return
      const rect = hovered.element.getBoundingClientRect()
      void window.dshHub?.runtime.showTooltip({
        text: hovered.name,
        x: 72,
        y: Math.round(rect.top + rect.height / 2)
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [rail])

  // 窗口失焦时清理悬停提示与拖拽状态：合并为一个 blur 监听器（两处都在切换应用时收尾）。
  useEffect(() => {
    const onBlur = (): void => {
      hoveredInstanceRef.current = null
      void window.dshHub?.runtime.hideTooltip()
      setDraggedId(null)
      setDragOverId(null)
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [])

  useEffect(() => () => void window.dshHub?.runtime.hideTooltip(), [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return instances
    return instances.filter(
      (item) => item.name.toLowerCase().includes(q) || item.address.toLowerCase().includes(q)
    )
  }, [instances, query])

  const grouped = useMemo(() => {
    if (!groupByType) return null
    const order: Transport[] = ['local', 'ssh', 'http']
    return order
      .map((transport) => ({
        transport,
        items: filtered.filter((item) => item.transport === transport)
      }))
      .filter((group) => group.items.length > 0)
  }, [filtered, groupByType])

  // —— 快捷键序号:按住 ⌘/Ctrl 满 0.5 秒显示 #1-#9;修饰键+数字立即切换,不等显示 ——
  // 序号跟随当前可见顺序(搜索/分组后随之变化),与用户看到的行序一致。
  const switchOrder = useMemo(
    () => (grouped ? grouped.flatMap((group) => group.items) : filtered).map((item) => item.id),
    [grouped, filtered]
  )
  const hotkeyNumbers = useMemo(() => {
    const numbers = new Map<string, number>()
    switchOrder.forEach((id, index) => {
      if (index < HOTKEY_LIMIT) numbers.set(id, index + 1)
    })
    return numbers
  }, [switchOrder])

  // 序号经 ref 取最新顺序:状态事件会重建列表引用,监听器因此只绑定一次。
  const switchOrderRef = useRef(switchOrder)
  useEffect(() => {
    switchOrderRef.current = switchOrder
  }, [switchOrder])

  useEffect(() => {
    const heldModifiers = new Set<string>()
    // 切换修饰键按平台区分:macOS 为 Meta(⌘),其余平台(Windows/Linux)为 Alt。
    // 每次按键实时读取平台(data-platform 在 app:info 到达后才写入,不能在挂载时快照)。
    const isSwitchModifier = (keyName: string): boolean =>
      keyName === switchModifierKey(rendererPlatform())
    let hintTimer: ReturnType<typeof setTimeout> | null = null
    let hintVisible = false
    /** 收起角标并取消未到期的显示计时(松开全部修饰键或窗口失焦时)。 */
    const hideHint = (): void => {
      if (hintTimer !== null) {
        clearTimeout(hintTimer)
        hintTimer = null
      }
      if (hintVisible) {
        hintVisible = false
        setHotkeyHeld(false)
      }
    }
    /** 排一次延迟显示计时;同一轮按住只排一次,按键自动重复不重启窗口。 */
    const scheduleHint = (): void => {
      if (hintTimer !== null || hintVisible) return
      hintTimer = setTimeout(() => {
        hintTimer = null
        hintVisible = true
        setHotkeyHeld(true)
      }, HOTKEY_HINT_DELAY_MS)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isSwitchModifier(event.key)) {
        const firstModifier = heldModifiers.size === 0
        heldModifiers.add(event.key)
        if (firstModifier) scheduleHint()
        return
      }
      // 切换路径不经过显示计时:数字键按下即生效。
      const index = instanceSwitchIndex(event)
      if (index === null) return
      const id = switchOrderRef.current[index]
      if (id === undefined) return
      event.preventDefault()
      useAppStore.getState().openFromSidebar(id)
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      if (!isSwitchModifier(event.key)) return
      heldModifiers.delete(event.key)
      if (heldModifiers.size === 0) hideHint()
    }
    // 失焦后 keyup 可能不再到达:离开窗口即收起序号,避免角标残留。
    const onBlur = (): void => {
      heldModifiers.clear()
      hideHint()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    // 工作区原生视图持焦时按键不经过本窗口:主进程白名单转发后在此还原为窗口事件。
    const unsubscribe = window.dshHub?.onWorkspaceHotkey((event: WorkspaceHotkeyEvent) => {
      window.dispatchEvent(
        new KeyboardEvent(event.phase === 'down' ? 'keydown' : 'keyup', {
          key: event.key,
          code: event.code,
          metaKey: event.meta,
          ctrlKey: event.ctrl,
          altKey: event.alt
        })
      )
    })
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      hideHint()
      unsubscribe?.()
    }
  }, [])

  // —— 拖拽事件回调 ——

  const handleDragStart = useCallback(
    (itemId: string, event: React.DragEvent): void => {
      // 分组模式下禁用拖拽
      if (grouped) return
      setDraggedId(itemId)
      dragStartOrderRef.current = instances.map((i) => i.id)
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', itemId)
    },
    [grouped, instances]
  )

  const handleDragOver = useCallback(
    (itemId: string, event: React.DragEvent): void => {
      if (!draggedId || draggedId === itemId) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      const rect = event.currentTarget.getBoundingClientRect()
      const midY = rect.top + rect.height / 2
      const pos: 'top' | 'bottom' = event.clientY < midY ? 'top' : 'bottom'
      // 同时写 ref(即时)和 state(渲染指示线)
      dropTargetRef.current = { id: itemId, position: pos }
      setDragOverId(itemId)
      setDragPosition(pos)
    },
    [draggedId]
  )

  const handleDrop = useCallback(
    (itemId: string): void => {
      if (!draggedId || draggedId === itemId) return
      const order =
        dragStartOrderRef.current.length > 0
          ? dragStartOrderRef.current
          : instances.map((i) => i.id)
      const fromIndex = order.indexOf(draggedId)
      const toIndex = order.indexOf(itemId)
      if (fromIndex === -1 || toIndex === -1) return

      // 从 ref 读取即时放下位置(不依赖可能过期的 state 闭包)
      const target = dropTargetRef.current
      const position = target?.id === itemId ? target.position : 'bottom'

      const newOrder = order.filter((id) => id !== draggedId)
      let insertAt = newOrder.indexOf(itemId)
      if (position === 'bottom') insertAt += 1
      newOrder.splice(insertAt, 0, draggedId)

      if (newOrder.some((id, i) => id !== order[i])) {
        void reorderInstances(newOrder)
      }
      setDraggedId(null)
      setDragOverId(null)
      dropTargetRef.current = null
    },
    [draggedId, instances, reorderInstances]
  )

  const handleDragEnd = useCallback((): void => {
    setDraggedId(null)
    setDragOverId(null)
    dropTargetRef.current = null
    dragStartOrderRef.current = []
  }, [])

  /** 分组视图不可拖拽；混排视图整表可拖拽排序。两处渲染共用同一份拖拽接线。 */
  const renderItem = (item: InstanceSummary, draggable: boolean): ReactNode => (
    <InstanceItem
      key={item.id}
      item={item}
      onClick={openFromSidebar}
      selected={selection === item.id}
      rail={rail}
      hotkey={hotkeyNumbers.get(item.id)}
      onRailTooltip={showRailTooltip}
      onRailTooltipHide={hideRailTooltip}
      draggable={draggable}
      isDragging={draggable && draggedId === item.id}
      onDragStart={draggable ? (event) => handleDragStart(item.id, event) : undefined}
      onDragOver={draggable ? (event) => handleDragOver(item.id, event) : undefined}
      onDrop={draggable ? () => handleDrop(item.id) : undefined}
      onDragEnd={draggable ? handleDragEnd : undefined}
      dragOver={draggable && dragOverId === item.id && draggedId !== item.id}
      dragPosition={draggable && dragOverId === item.id ? dragPosition : undefined}
    />
  )

  return (
    <aside className={`sidebar${hotkeyHeld ? ' hotkey-mode' : ''}`} data-testid="sidebar">
      <div className="side-head">
        <button
          className="brand"
          onClick={() => select(null)}
          title={t('nav.backToWorkbench')}
          data-testid="brand"
        >
          <span className="brand-mark">
            <img src={logoUrl} alt="" />
          </span>
          <span className="brand-text">
            <b>DSH Hub</b>
            <em>{t('nav.brandTagline')}</em>
          </span>
        </button>
      </div>
      <div className="side-tools">
        <label className="search">
          <Icon name="search" />
          <input
            type="search"
            placeholder={t('nav.searchPlaceholder')}
            aria-label={t('nav.searchLabel')}
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="seg" role="group" aria-label={t('nav.groupBy')}>
          <button aria-pressed={!groupByType} onClick={() => setGroupByType(false)}>
            {t('nav.groupMixed')}
          </button>
          <button aria-pressed={groupByType} onClick={() => setGroupByType(true)}>
            {t('nav.groupByType')}
          </button>
        </div>
      </div>
      <nav className="side-scroll" aria-label={t('nav.instanceList')}>
        {grouped
          ? grouped.map((group) => (
              <div key={group.transport}>
                <div className="group-head">
                  <span>
                    {t(TYPE_INFO[group.transport].labelKey)} · {group.items.length}
                  </span>
                </div>
                {group.items.map((item) => renderItem(item, false))}
              </div>
            ))
          : filtered.map((item) => renderItem(item, true))}
      </nav>
      <div className="side-foot">
        <button
          className="btn btn-primary btn-block"
          onClick={() => setWizardOpen(true)}
          data-testid="new-instance-btn"
        >
          <span className="fx-icon">
            <Icon name="plus" />
          </span>
          <span className="fx-label">{t('nav.newInstance')}</span>
        </button>
        <div className="row">
          <button
            className="btn btn-ghost btn-sm"
            data-testid="settings-btn"
            onClick={() => setSettingsOpen(true)}
          >
            <Icon name="gear" />
            <span className="fx-label">{t('nav.settings')}</span>
          </button>
          <button
            className="btn btn-ghost btn-sm icon-btn"
            title={theme === 'light' ? t('nav.toDark') : t('nav.toLight')}
            onClick={toggleTheme}
            data-testid="theme-toggle"
          >
            <Icon name={theme === 'light' ? 'moon' : 'sun'} />
          </button>
          <button
            className="btn btn-ghost btn-sm icon-btn collapse-btn"
            aria-label={rail ? t('nav.expandSidebar') : t('nav.collapseSidebar')}
            title={`${rail ? t('nav.expandSidebar') : t('nav.collapseSidebar')} (⌘B)`}
            onClick={toggleRail}
            data-testid="sidebar-collapse-btn"
          >
            <Icon name={rail ? 'expand' : 'collapse'} />
          </button>
        </div>
      </div>
    </aside>
  )
}

function InstanceItem(props: {
  item: InstanceSummary
  selected: boolean
  rail: boolean
  /** 快捷键序号(1-9);undefined = 不参与序号展示与切换。 */
  hotkey?: number
  onClick: (id: string) => void
  onRailTooltip: (element: HTMLButtonElement, name: string) => void
  onRailTooltipHide: () => void
  draggable: boolean
  isDragging?: boolean
  onDragStart?: (event: React.DragEvent) => void
  onDragOver?: (event: React.DragEvent) => void
  onDrop?: () => void
  onDragEnd?: () => void
  dragOver: boolean
  dragPosition?: 'top' | 'bottom'
}): ReactNode {
  const t = useAppStore((state) => state.t)
  // 只订阅本实例的状态切片，避免任一实例的状态事件重渲染整列。
  const status = useAppStore((state) => state.statuses[props.item.id]?.status)
  const connected = useAppStore((state) => state.workspaceConnected[props.item.id] ?? true)
  const display = toDisplayStatus(status, connected)
  const info = STATUS_INFO[display]

  const classNames = ['inst']
  if (props.selected) classNames.push('selected')
  if (props.isDragging) classNames.push('dragging')
  if (props.dragOver)
    classNames.push(props.dragPosition === 'top' ? 'drag-over-top' : 'drag-over-bottom')

  return (
    <button
      className={classNames.join(' ')}
      aria-current={props.selected}
      onClick={() => props.onClick(props.item.id)}
      onPointerEnter={(event) => props.onRailTooltip(event.currentTarget, props.item.name)}
      onPointerLeave={props.onRailTooltipHide}
      onPointerCancel={props.onRailTooltipHide}
      onFocus={(event) => props.onRailTooltip(event.currentTarget, props.item.name)}
      onBlur={props.onRailTooltipHide}
      aria-keyshortcuts={
        props.hotkey !== undefined
          ? `${switchModifierKey(rendererPlatform())}+${props.hotkey}`
          : undefined
      }
      data-testid={`inst-${props.item.id}`}
      title={props.rail ? props.item.name : props.item.address}
      draggable={props.draggable}
      onDragStart={props.onDragStart}
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
      onDragEnd={props.onDragEnd}
    >
      <span className={`status-dot ${info.dotClass}`} aria-hidden="true" />
      <span className="inst-text">
        <span className="inst-name">{props.item.name}</span>
        <span className="inst-meta num">{props.item.address}</span>
      </span>
      <span className="badge">
        <Icon name={TYPE_INFO[props.item.transport].icon} size={11} />
        <span className="type-label">{t(TYPE_INFO[props.item.transport].labelKey)}</span>
      </span>
      {props.hotkey !== undefined && (
        <span
          className="inst-hotkey"
          data-testid={`hotkey-badge-${props.hotkey}`}
          aria-hidden="true"
        >
          #{props.hotkey}
        </span>
      )}
    </button>
  )
}
