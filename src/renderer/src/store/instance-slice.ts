/** 实例列表、详情缓存、运行状态、认证相位与活动日志分片。 */
import type { InstanceRecord, InstanceStatusEvent, InstanceSummary } from '@shared/contracts'
import type { InstanceSlice, SliceCreator } from './types'
import { hydrateAndSubscribeTheme } from './settings-slice'
import { workspaceOpenInFlight } from './workspace-slice'

/** 活动日志每实例保留上限。 */
const ACTIVITY_LIMIT = 200

/** 活动日志行的单调递增序号（React key）：截尾到 200 行后不随之左移，DOM 节点稳定复用。 */
let activitySeq = 0

export const createInstanceSlice: SliceCreator<InstanceSlice> = (set, get) => ({
  loaded: false,
  listError: null,
  instances: [],
  records: {},
  statuses: {},
  userDataPath: null,
  defaultDshHome: null,
  authPhases: {},
  activityLog: {},
  autoDisabledNotified: {},

  load: async () => {
    // 先获取主进程快照(含系统区域设置),再用它解析「跟随系统」语言偏好。
    const info = await window.dshHub?.getInfo()
    if (info?.ok) {
      document.documentElement.dataset.platform = info.value.platform
      set({
        userDataPath: info.value.userDataPath,
        defaultDshHome: info.value.defaultDshHome,
        systemLocale: info.value.locale
      })
    }
    await hydrateAndSubscribeTheme(get)
    await get().refreshList()
    // 刷新渲染层（Cmd+R）后回到上次视图：记录先取回来再切视图，避免详情页闪出占位；
    // 在 loaded 置位前完成，首帧就落在目标视图上。
    await get().restoreView()
    set({ loaded: true })
  },

  refreshList: async () => {
    const bridge = window.dshHub
    if (!bridge) return
    const result = await bridge.instances.list()
    if (result.ok) {
      const snapshotStatuses = result.value.reduce<Record<string, InstanceStatusEvent>>(
        (statuses, instance) => {
          if (instance.runtimeStatus) {
            statuses[instance.id] = {
              id: instance.id,
              status: instance.runtimeStatus,
              at: instance.updatedAt
            }
          }
          return statuses
        },
        {}
      )
      // 推送事件优先于列表快照，避免列表读取期间的旧快照覆盖最新状态。
      set((state) => ({
        instances: result.value,
        statuses: { ...snapshotStatuses, ...state.statuses },
        listError: null
      }))
    } else {
      // 加载失败必须可见：静默失败会把错误态渲染成「还没有实例」。
      set({ listError: result.message })
    }
  },

  reorderInstances: async (orderedIds) => {
    const bridge = window.dshHub
    if (!bridge) return
    // 乐观更新:立即重排本地数组
    set((state) => {
      const byId = new Map(state.instances.map((inst) => [inst.id, inst]))
      const reordered = orderedIds.map((id) => byId.get(id)).filter(Boolean) as InstanceSummary[]
      return { instances: reordered }
    })
    // 持久化
    const result = await bridge.instances.reorder(orderedIds)
    if (!result.ok) {
      // 失败回滚:从主进程重新拉取
      await get().refreshList()
    }
  },

  applyAuthPhase: (instanceId, phase) => {
    set((state) => ({ authPhases: { ...state.authPhases, [instanceId]: phase } }))
  },

  appendActivity: (instanceId, line) => {
    set((state) => {
      const current = state.activityLog[instanceId] ?? []
      const last = current[current.length - 1]
      const duplicateRuntime =
        last !== undefined &&
        last.source === 'runtime' &&
        line.source === 'runtime' &&
        last.detail === line.detail
      const duplicateVersion =
        last !== undefined &&
        last.source === 'version' &&
        line.source === 'version' &&
        last.event.phase === line.event.phase &&
        last.event.detail === line.event.detail &&
        last.event.error === line.event.error
      // 连续重复行去重：状态重播与同值进度事件不刷屏。
      if (duplicateRuntime || duplicateVersion) return state
      // 分配单调递增 seq 作为 React key：截尾不改变已存在行的 seq，DOM 节点得以稳定复用。
      const next = [...current, { ...line, seq: ++activitySeq }]
      return {
        activityLog: {
          ...state.activityLog,
          [instanceId]:
            next.length > ACTIVITY_LIMIT ? next.slice(next.length - ACTIVITY_LIMIT) : next
        }
      }
    })
  },

  clearActivity: (instanceId) => {
    set((state) => {
      if (!(instanceId in state.activityLog)) return state
      const activityLog = { ...state.activityLog }
      delete activityLog[instanceId]
      return { activityLog }
    })
  },

  notifyAutoDisabledOnce: (instanceId, dshVersion) => {
    // 先同步判定再登记：两次并发加载里只有先到的一次能拿到发送权。
    if ((get().autoDisabledNotified[instanceId] ?? null) === dshVersion) return false
    set((state) => ({
      autoDisabledNotified: { ...state.autoDisabledNotified, [instanceId]: dshVersion }
    }))
    return true
  },

  applyStatus: (event) => {
    let shouldOpen: string | null = null
    let shouldGate: string | null = null
    set((state) => {
      const removed = event.status === 'stopped'
      const statuses = { ...state.statuses }
      if (removed) delete statuses[event.id]
      else statuses[event.id] = event
      // 列表摘要不是详情记录的实时投影；本机运行事件已给出实际监听端口，立即更新地址。
      const instances = state.instances.map((instance) =>
        instance.id === event.id && instance.transport === 'local' && event.port !== undefined
          ? { ...instance, address: `127.0.0.1:${event.port}` }
          : instance
      )
      // 启动命令随状态事件落到详情记录：stopped 会清掉 statuses，该行仍能显示最近一次的命令。
      let records = state.records
      const commandTarget = event.command !== undefined ? records[event.id] : undefined
      if (event.command !== undefined && commandTarget?.transport === 'local') {
        records = { ...records, [event.id]: { ...commandTarget, runCommand: event.command } }
      }
      // 运行后自动打开工作区；失败或停止时移除待打开记录。
      let pendingOpen = state.pendingOpen
      // 远程实例的「先登录再打开」门：运行后先探测认证决定弹登录框还是直接开工作区；
      // 失败/停止时清除该标记。
      let loginGate = state.loginGate
      const gated = loginGate.includes(event.id)
      if (pendingOpen.includes(event.id)) {
        if (event.status === 'running') {
          pendingOpen = pendingOpen.filter((id) => id !== event.id)
          if (gated) shouldGate = event.id
          else shouldOpen = event.id
        } else if (event.status === 'error' || event.status === 'stopped') {
          pendingOpen = pendingOpen.filter((id) => id !== event.id)
        }
      }
      if ((event.status === 'error' || event.status === 'stopped') && gated) {
        loginGate = loginGate.filter((id) => id !== event.id)
      }
      if (state.workspaceOpening && state.selection === event.id) {
        // 在途打开尚未返回时不重复触发:重复触发会先隐藏原生视图,而主进程会把
        // 两次打开按同实例合并,渲染层状态不再变化,内容区边界不会重新回传。
        if (event.status === 'running' && workspaceOpenInFlight() !== event.id && !gated) {
          shouldOpen = event.id
        }
        if (event.status === 'error' || event.status === 'stopped') {
          return {
            instances,
            statuses,
            records,
            pendingOpen,
            loginGate,
            workspaceOpening: false,
            workspaceConnected:
              event.status === 'stopped'
                ? { ...state.workspaceConnected, [event.id]: false }
                : state.workspaceConnected
          }
        }
      }
      return {
        instances,
        statuses,
        records,
        pendingOpen,
        loginGate,
        workspaceConnected:
          event.status === 'stopped'
            ? { ...state.workspaceConnected, [event.id]: false }
            : state.workspaceConnected
      }
    })
    if (shouldGate !== null) void get().openWorkspaceOrLogin(shouldGate)
    else if (shouldOpen !== null) void get().openWorkspace(shouldOpen)
  },

  ensureRecord: async (id) => {
    const cached = get().records[id]
    if (cached) return cached
    const result = await window.dshHub?.instances.get(id)
    if (result?.ok && result.value) {
      set((state) => ({ records: { ...state.records, [id]: result.value as InstanceRecord } }))
      return result.value as InstanceRecord
    }
    return null
  },

  reloadRecord: async (id) => {
    const result = await window.dshHub?.instances.get(id)
    if (result?.ok && result.value) {
      set((state) => ({ records: { ...state.records, [id]: result.value as InstanceRecord } }))
    }
  },

  removeInstance: async (input) => {
    const t = get().t
    const result = await window.dshHub?.instances.remove(input.id, { trashSpace: input.trashSpace })
    if (!result?.ok) {
      if (result) get().toast('err', t('detail.deleteFailed'), result.message)
      return false
    }
    get().toast('ok', t('detail.deleted', { name: input.name }))
    return true
  }
})
