import { useEffect, useLayoutEffect, useRef } from 'react'
import { useAppStore } from './store'
import Sidebar from './components/Sidebar'
import HomeView from './components/HomeView'
import EmptyView from './components/EmptyView'
import DetailView from './components/DetailView'
import Wizard from './components/Wizard'
import Toasts from './components/Toasts'
import SshDialogs from './components/SshDialogs'
import RuntimeConfirmDialogs from './components/RuntimeConfirmDialogs'
import AuthPanel from './components/AuthPanel'
import SettingsView from './components/SettingsView'
import { compactWorkspaceAddress, STATUS_INFO, toDisplayStatus } from './lib/format'
import { shouldReopenWorkspace } from './lib/auth-panel-state'
import { Icon } from './lib/icons'

const BRIDGE = window.dshHub

/**
 * 应用外壳：侧边栏 + 主内容区 + 浮层。
 * 视图路由：首载骨架 → 空态 / 总览表格 / 实例详情；向导与 Toast 为全局浮层。
 */
export default function App() {
  const loaded = useAppStore((state) => state.loaded)
  const listError = useAppStore((state) => state.listError)
  const refreshList = useAppStore((state) => state.refreshList)
  const instances = useAppStore((state) => state.instances)
  const selection = useAppStore((state) => state.selection)
  const settingsOpen = useAppStore((state) => state.settingsOpen)
  const t = useAppStore((state) => state.t)
  const rail = useAppStore((state) => state.rail)
  const wizardOpen = useAppStore((state) => state.wizardOpen)
  const toggleRail = useAppStore((state) => state.toggleRail)
  const setWizardOpen = useAppStore((state) => state.setWizardOpen)
  // 只订阅当前选中实例的状态切片，避免非选中实例的状态事件重渲染整个外壳。
  const selectedStatus = useAppStore((state) => (selection ? state.statuses[selection] : undefined))
  const selectedConnected = useAppStore((state) =>
    selection ? (state.workspaceConnected[selection] ?? true) : true
  )
  const workspaceOpen = useAppStore((state) => state.workspaceOpen)
  const workspaceOpening = useAppStore((state) => state.workspaceOpening)
  const setWorkspaceOpen = useAppStore((state) => state.setWorkspaceOpen)
  const contentRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!BRIDGE) return
    void useAppStore.getState().load()
    // 状态事件 → store(主进程 → preload → 渲染,唯一状态推进来源)；
    // 带 detail 的状态行同时进入详情页底部信息栏（标题区不再展示原始日志）。
    const unsubscribeStatus = BRIDGE.onInstanceStatus((event) => {
      const state = useAppStore.getState()
      state.applyStatus(event)
      if (event.detail) {
        state.appendActivity(event.id, { source: 'runtime', at: event.at, detail: event.detail })
      }
    })
    // 版本升级进度 → 底部信息栏的安装进度日志；进度条本身由组件本地订阅渲染。
    const unsubscribeVersion = BRIDGE.onVersionProgress((event) =>
      useAppStore.getState().appendActivity(event.instanceId, { source: 'version', event })
    )
    // 认证相位写入 store；应用级订阅确保详情按钮收到状态更新。
    // 「重新登录成功」时自动重开工作区：用户从已连接的工作区返回详情重新登录
    // （远端 dsh 重启导致会话失效）后，无需再手动点「打开工作区」。手动登录、显式已存密码
    // 登录、以及打开面板探测时的已存密码静默登录都经 auth:state 到达 connected，统一在此覆盖。
    const unsubscribeAuth = BRIDGE.auth.onState((event) => {
      const store = useAppStore.getState()
      const previousPhase = store.authPhases[event.instanceId]
      store.applyAuthPhase(event.instanceId, event.state.phase)
      // 新建远程实例的「先登录再打开」门：登录成功（connected）后打开工作区并清除标记。
      if (event.state.phase === 'connected' && store.loginGate.includes(event.instanceId)) {
        useAppStore.setState((state) => ({
          loginGate: state.loginGate.filter((id) => id !== event.instanceId)
        }))
        void store.reopenWorkspaceRefreshed(event.instanceId)
        return
      }
      if (
        shouldReopenWorkspace({
          phase: event.state.phase,
          previousPhase,
          workspaceConnected: store.workspaceConnected[event.instanceId] ?? false,
          workspaceOpen: store.workspaceOpen,
          overlayBusy: store.wizardOpen || store.settingsOpen || store.workspaceOpening
        })
      ) {
        void store.reopenWorkspaceRefreshed(event.instanceId)
      }
    })
    return () => {
      unsubscribeStatus()
      unsubscribeVersion()
      unsubscribeAuth()
    }
  }, [])

  useLayoutEffect(() => {
    if (!workspaceOpen || !contentRef.current) return
    const element = contentRef.current
    const updateBounds = (): void => {
      const rect = element.getBoundingClientRect()
      void window.dshHub?.runtime.updateViewBounds({
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.max(0, Math.round(rect.height))
      })
    }
    updateBounds()
    const observer = new ResizeObserver(updateBounds)
    observer.observe(element)
    window.addEventListener('resize', updateBounds)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateBounds)
    }
  }, [workspaceOpen, rail])
  // 快捷键:⌘N 新建实例 · ⌘B 折叠侧栏
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!event.metaKey && !event.ctrlKey) return
      if (event.key === 'n') {
        event.preventDefault()
        setWizardOpen(true)
      } else if (event.key === 'b') {
        event.preventDefault()
        toggleRail()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setWizardOpen, toggleRail])

  const selectedInstance = selection
    ? instances.find((instance) => instance.id === selection)
    : undefined
  const workspaceAddress =
    workspaceOpen && selectedInstance
      ? compactWorkspaceAddress(selectedInstance.address)
      : undefined
  const title = t('nav.overview')

  return (
    <div
      className={`app-shell${rail ? ' rail' : ''}${workspaceOpen || workspaceOpening ? ' workspace-auth-scope' : ''}`}
      data-testid="app-shell"
    >
      {/* 顶栏横跨侧边栏和主区，为 macOS 窗口控件预留空间。 */}
      <div className="topbar">
        <div className="tb-left">
          <span className="tb-title" data-testid="tb-title">
            {settingsOpen
              ? t('settings.title')
              : workspaceOpen && selectedInstance
                ? selectedInstance.name
                : workspaceOpening
                  ? t('detail.openingWorkspace')
                  : selection
                    ? t('detail.instanceDetail')
                    : title}
          </span>
          <span className="tb-sub" data-testid="tb-sub">
            {/* 副标题只给必要信息（地址 / 状态短标签 / 实例数）；状态详情在详情页底部信息栏。 */}
            {workspaceOpen
              ? (workspaceAddress ?? selectedInstance?.name ?? t('common.unknown'))
              : selectedStatus !== undefined && selection !== null
                ? t(STATUS_INFO[toDisplayStatus(selectedStatus.status, selectedConnected)].labelKey)
                : t('nav.instanceCount', { n: instances.length })}
          </span>
        </div>
        {workspaceOpen && (
          <div className="tb-right">
            <button
              className="workspace-back"
              onClick={() => {
                void window.dshHub?.runtime.hideView()
                setWorkspaceOpen(false)
              }}
              data-testid="workspace-back-btn"
            >
              <Icon name="back" /> {t('detail.instanceDetail')}
            </button>
          </div>
        )}
      </div>
      <Sidebar />
      <main ref={contentRef} className={`content${workspaceOpen ? ' workspace-active' : ''}`}>
        <div className="content-scroll" data-testid="content-scroll">
          {settingsOpen ? (
            <SettingsView />
          ) : workspaceOpening ? (
            <section
              className="workspace-loading"
              aria-busy="true"
              aria-live="polite"
              data-testid="workspace-loading"
            >
              <Icon name="refresh" />
              <h2>{t('detail.openingWorkspace')}</h2>
              <p>{selectedInstance?.name ?? t('common.loading')}</p>
            </section>
          ) : selection !== null && loaded ? (
            <DetailView key={selection} />
          ) : !loaded ? (
            <HomeView />
          ) : listError !== null ? (
            // 布局沿用空态卡片：设计稿没有错误态专页，保持同一视觉语言。
            <section data-od-id="view-list-error" data-testid="list-error">
              <div className="empty">
                <span className="glyph">
                  <Icon name="alert" size={76} />
                </span>
                <h2>{t('home.listErrorTitle')}</h2>
                <p className="meta">{listError}</p>
                <button
                  className="btn btn-primary"
                  style={{ marginTop: 4 }}
                  data-testid="list-error-retry"
                  onClick={() => void refreshList()}
                >
                  {t('home.listErrorRetry')}
                </button>
              </div>
            </section>
          ) : instances.length === 0 ? (
            <EmptyView />
          ) : (
            <HomeView />
          )}
        </div>
      </main>
      {wizardOpen && <Wizard />}
      <SshDialogs />
      <RuntimeConfirmDialogs />
      <AuthPanel />
      <Toasts />
    </div>
  )
}
