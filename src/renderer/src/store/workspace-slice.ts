/** 工作区导航、选中、向导与设置页开合分片。 */
import type { SliceCreator, WorkspaceSlice } from './types'
import {
  createNavigationGuard,
  suspendForWizardPatch,
  toDetailPatch,
  toDisconnectedPatch,
  toOpenPatch,
  toOpeningPatch,
  toSettingsPatch,
  toWizardClosedPatch
} from '../lib/workspace-navigation'
import { readPersistedView, writePersistedView } from '../lib/view-persistence'

/**
 * 工作区导航代守卫：换视图递增代号，过期 openView 响应据此自我作废；
 * 同时记录「正在打开的实例」，供 instance slice 的 applyStatus 判定在途打开。
 */
const navigation = createNavigationGuard()

/**
 * 加载中间页停留上限：openView 响应丢失、或依赖的 running 事件永不到达时，
 * 超时回退到详情页并提示——界面绝不停在「正在打开工作区…」。
 * 取值需小于 E2E 对打开流程的 20s 等待预算，又要给真实启动留足余量。
 */
const OPENING_TIMEOUT_MS = 10_000

/** 供 instance slice 的 applyStatus 判定「在途打开」用（跨分片只读）。 */
export function workspaceOpenInFlight(): string | null {
  return navigation.inFlight()
}

export const createWorkspaceSlice: SliceCreator<WorkspaceSlice> = (set, get) => {
  /** 本次加载超时兜底的定时器；携带 id+导航代，只归自己的尝试所有。 */
  let opening: { id: string; generation: number; timer: ReturnType<typeof setTimeout> } | null =
    null

  /** 武装加载超时兜底（同一时刻只保留最新一次尝试的定时器）。 */
  const armOpeningTimeout = (id: string, generation: number): void => {
    disarmOpeningTimeout()
    const timer = setTimeout(() => {
      opening = null
      if (
        navigation.isCurrent(generation) &&
        get().selection === id &&
        get().workspaceOpening &&
        !get().workspaceOpen
      ) {
        navigation.clearInFlight(id, generation)
        set({ workspaceOpening: false })
        get().toast('err', get().t('detail.openViewTimeout'))
      }
    }, OPENING_TIMEOUT_MS)
    timer.unref?.()
    opening = { id, generation, timer }
  }

  /** 拆除超时兜底；只拆属于本次尝试的（过期响应不能清掉新一次的定时器）。 */
  const disarmOpeningTimeout = (id?: string, generation?: number): void => {
    if (opening === null) return
    if (id !== undefined && (opening.id !== id || opening.generation !== generation)) return
    clearTimeout(opening.timer)
    opening = null
  }

  return {
    selection: null,
    workspaceOpen: false,
    workspaceOpening: false,
    workspaceSuspended: false,
    workspaceConnected: {},
    wizardOpen: false,
    wizardExistingSpaceId: null,
    settingsOpen: false,
    pendingOpen: [],
    loginGate: [],

    setWorkspaceOpen: (open) => set({ workspaceOpen: open, workspaceOpening: false }),

    // 实例与总览导航优先于设置页：否则 settingsOpen 一直为 true，侧栏点击看似
    // 改了 selection，App 却始终渲染 SettingsView，用户被困在设置页。
    select: (id) => {
      navigation.begin()
      void window.dshHub?.runtime?.hideView()
      // 挂起标记属于换 selection 前被遮挡的工作区；待打开标记同理——切走后
      // 不再等该实例启动完成，否则 running 事件会把界面强行拽回工作区。
      set(toDetailPatch(id))
      writePersistedView(sessionStorage, { selection: id, settingsOpen: false })
    },

    openDetail: (id) => {
      void get().ensureRecord(id)
      get().select(id)
    },

    openWorkspace: async (id) => {
      // 已在同一实例的工作区内时不重开:重开会先隐藏原生视图,而重开请求若被
      // 主进程按同实例去重合并,渲染层不会再回传内容区边界,视图会停在零尺寸。
      if (get().selection === id && get().workspaceOpen) return
      const generation = navigation.begin(id)
      try {
        void window.dshHub?.runtime?.hideView()
        set(toOpeningPatch(id))
        armOpeningTimeout(id, generation)
        const result = await window.dshHub?.runtime.openView(id)
        // A later selection/open request owns the native view. Stale responses only stop themselves.
        if (!navigation.isCurrent(generation) || get().selection !== id) return
        if (result?.ok) {
          set((state) => toOpenPatch(id, state.workspaceConnected))
          return
        }
        set({ workspaceOpening: false })
        if (result) get().toast('err', get().t('detail.openViewFailed'), result.message)
      } finally {
        disarmOpeningTimeout(id, generation)
        navigation.clearInFlight(id, generation)
      }
    },

    reopenWorkspaceRefreshed: async (id) => {
      // 重新登录成功后：先打开工作区（openView 可能复用会话失效前的缓存视图），
      // 再强制刷新——主进程注入最新会话 Cookie 并导航回工作区 URL，否则视图停在旧页面。
      await get().openWorkspace(id)
      // 仅在确实打开到该实例的工作区时刷新，避免打开失败（如实例未运行）后仍去刷新。
      if (get().selection === id && get().workspaceOpen) {
        await window.dshHub?.runtime.reloadView(id)
      }
    },

    openWorkspaceOrLogin: async (id) => {
      const name = get().instances.find((item) => item.id === id)?.name ?? id.slice(0, 8)
      // 远程实例运行后先探测认证：网关要求登录（await-credentials / needs-auth / await-otp）时
      // 先弹登录框引导登录，保留 loginGate，待登录成功（connected）由 App 的 auth 订阅打开工作区；
      // 其余相位（无网关 / 已连接 / 探测失败）直接打开工作区。
      const result = await window.dshHub?.auth.probe(id)
      const phase = result?.ok ? (result.value?.phase ?? null) : null
      const needsLogin =
        phase === 'needs-auth' || phase === 'await-credentials' || phase === 'await-otp'
      if (needsLogin) {
        window.dispatchEvent(new CustomEvent('dsh-hub:open-auth', { detail: { id, name } }))
        return
      }
      set((state) => ({ loginGate: state.loginGate.filter((item) => item !== id) }))
      void get().openWorkspace(id)
    },

    disconnectWorkspace: async (id) => {
      const generation = navigation.begin()
      const result = await window.dshHub?.runtime.disconnectView(id)
      if (!navigation.isCurrent(generation)) return
      if (!result?.ok) {
        if (result) get().toast('err', get().t('detail.openViewFailed'), result.message)
        return
      }
      set((state) => toDisconnectedPatch(id, state.workspaceConnected))
      get().toast('ok', get().t('detail.disconnected'))
    },

    openFromSidebar: (id) => {
      const instance = get().instances.find((item) => item.id === id)
      const status = get().statuses[id]?.status ?? instance?.runtimeStatus
      if (status === 'error') {
        get().select(id)
        return
      }
      if (status === 'starting') {
        // 不调 openView（端口尚未就绪）：只进加载页等 running 事件重触发。
        // 事件可能因状态陈旧永不抵达——超时兜底保证界面能退出加载页。
        const generation = navigation.begin()
        void window.dshHub?.runtime?.hideView()
        set(toOpeningPatch(id))
        armOpeningTimeout(id, generation)
        return
      }
      void get().openWorkspace(id)
    },

    setWizardOpen: (open) => {
      const state = get()
      if (!open) set({ wizardExistingSpaceId: null })
      if (open) {
        const suspendWorkspace = state.workspaceOpen && state.selection !== null
        if (suspendWorkspace) {
          navigation.begin()
          // WebContentsView 是独立于 React DOM 的原生子视图；确认隐藏后才挂载向导，
          // 否则它会覆盖新建实例弹窗。
          set(suspendForWizardPatch())
          void Promise.resolve(window.dshHub?.runtime?.hideView()).finally(() => {
            if (!get().wizardOpen) set({ wizardOpen: true })
          })
          return
        }
        set({ wizardOpen: true })
        return
      }

      const resumeId = state.workspaceSuspended && state.selection !== null ? state.selection : null
      set(toWizardClosedPatch(resumeId))
      if (!resumeId) return
      void window.dshHub?.runtime.openView(resumeId).then((result) => {
        if (
          result?.ok &&
          get().selection === resumeId &&
          !get().wizardOpen &&
          !get().settingsOpen
        ) {
          set({ workspaceOpen: true })
        }
      })
    },

    createWithExistingSpace: (id) => {
      set({ wizardExistingSpaceId: id, settingsOpen: false })
      get().setWizardOpen(true)
    },

    setSettingsOpen: (open) => {
      if (open) {
        navigation.begin()
        void window.dshHub?.runtime?.hideView()
      }
      // 打开设置页即放弃当前选中,被遮挡工作区不再有可恢复的目标,挂起与待打开
      // 标记一并清除——否则实例启动完成会强制切回工作区、关掉设置页。
      set(toSettingsPatch(open))
      // 关闭设置页时选中已在打开时清空，记下 null 即「回总览」。
      writePersistedView(sessionStorage, {
        selection: open ? null : get().selection,
        settingsOpen: open
      })
    },

    /**
     * 启动时恢复上次视图（刷新渲染层用；应用重启时 sessionStorage 已空，仍是总览）。
     * 选中的实例已不存在（被删除）或记录取不回来时留在总览：宁可不恢复，也不进一个空详情页。
     */
    restoreView: async () => {
      const view = readPersistedView(sessionStorage)
      if (
        view.selection !== null &&
        get().instances.some((instance) => instance.id === view.selection)
      ) {
        // 先取回记录再切视图：否则详情页会先渲染一帧「找不到该实例」占位。
        const record = await get().ensureRecord(view.selection)
        if (record !== null) get().select(view.selection)
        return
      }
      if (view.selection === null && view.settingsOpen) get().setSettingsOpen(true)
    },

    setPendingOpen: (id) => set((state) => ({ pendingOpen: [...state.pendingOpen, id] })),

    setLoginGate: (id) => set((state) => ({ loginGate: [...state.loginGate, id] }))
  }
}
