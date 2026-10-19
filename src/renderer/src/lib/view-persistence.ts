/**
 * 刷新（Cmd+R 重载渲染层）后要恢复的视图：详情页选中的实例，或设置页。
 *
 * 用 sessionStorage：同一次应用会话内刷新后回到原页面；应用重启则回到总览——重启用上次
 * 停留的详情页既意外，选中的实例也可能已被删除。恢复只是视图状态，数据一律重新拉取。
 */
export interface ViewStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

/** sessionStorage 键。 */
const VIEW_KEY = 'dshhub-view'

export interface PersistedView {
  /** 详情页选中的实例 id；null = 总览。 */
  selection: string | null
  /** 是否停留在设置页。 */
  settingsOpen: boolean
}

const OVERVIEW: PersistedView = { selection: null, settingsOpen: false }

/** 读取上次视图；缺失或损坏时回落到总览。 */
export function readPersistedView(storage: ViewStorage): PersistedView {
  try {
    const raw = storage.getItem(VIEW_KEY)
    if (raw === null) return { ...OVERVIEW }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      return { ...OVERVIEW }
    const record = parsed as Record<string, unknown>
    const selection =
      typeof record.selection === 'string' && record.selection !== '' ? record.selection : null
    return { selection, settingsOpen: record.settingsOpen === true }
  } catch {
    return { ...OVERVIEW }
  }
}

/** 记下当前视图；视图切换时调用。 */
export function writePersistedView(storage: ViewStorage, view: PersistedView): void {
  try {
    storage.setItem(VIEW_KEY, JSON.stringify(view))
  } catch {
    // 存储不可用只导致刷新后回到总览，其它功能不受影响。
  }
}
