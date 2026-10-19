/**
 *
 * - `updateTray: () => {}`(托盘菜单永不刷新 → 语言切换后菜单停在旧语言);
 * - `setLoginItem` 不落到 OS(「开机自启」开关形同虚设);
 * - `trayExists: () => false`(每次都重新建托盘/自启判定错乱)。
 *
 * 这里把「持有托盘引用 + 把动作交给 electron 原语」抽出来:
 * electron 只以**最窄的端口**注入(`createTray`/`refreshTrayMenu`/`applyLoginItem`),
 * 逻辑(何时创建/刷新、传什么参数、托盘是否存在)全部可在单测里断言。
 */
import type { HubTrayLabels } from '../tray'
import { loginItemSettings } from './native-decisions'
import type { NativeAction, NativeSettingsPorts } from './native-settings'

/** 托盘句柄的最小结构(生产 = electron Tray) */
export interface TrayLike {
  destroy(): void
}

/** 创建托盘所需参数(与 `tray.ts` 的 `CreateHubTrayOptions` 结构一致) */
export interface CreateTrayOptionsLike {
  iconPath: string
  labels: HubTrayLabels
  onShow: () => void
  onQuit: () => void
}

/** 端口实现所需的 electron 原语与动态取值(全部注入) */
export interface HubNativeDeps<TTray extends TrayLike> {
  /** 托盘图标路径(打包/开发两种布局的探测留在装配层) */
  iconPath(): string
  /** 托盘文案:随语言与运行中实例数变化,**每次使用都重新求值** */
  labels(): HubTrayLabels
  /** 生产 = `tray.ts` 的 `createHubTray` */
  createTray(options: CreateTrayOptionsLike): TTray
  /** 生产 = `tray.ts` 的 `updateTrayStatus`(菜单状态行跟随实例数) */
  refreshTrayMenu(tray: TTray, labels: HubTrayLabels, onShow: () => void, onQuit: () => void): void
  /** 生产 = `app.setLoginItemSettings`(真正把登录项写进 OS) */
  applyLoginItem(value: { openAtLogin: boolean; openAsHidden: boolean }): void
  onShow(): void
  onQuit(): void
  onError(error: unknown, action: NativeAction['kind']): void
}

export interface HubNativePorts<TTray extends TrayLike> extends NativeSettingsPorts {
  /** 当前**真实存在**的托盘(close-to-tray 与状态行刷新都读它,而不是读偏好) */
  currentTray(): TTray | null
}

export function createHubNativePorts<TTray extends TrayLike>(
  deps: HubNativeDeps<TTray>
): HubNativePorts<TTray> {
  let tray: TTray | null = null

  return {
    currentTray: () => tray,

    trayExists: () => tray !== null,

    createTray() {
      // 创建时重新求值图标与文案(语言可能在偏好落盘后已切换)
      tray = deps.createTray({
        iconPath: deps.iconPath(),
        labels: deps.labels(),
        onShow: deps.onShow,
        onQuit: deps.onQuit
      })
    },

    destroyTray() {
      tray?.destroy()
      tray = null
    },

    updateTray() {
      // 没有托盘时绝不触碰 electron(创建失败时刷新会对着 null 调用)
      if (!tray) return
      deps.refreshTrayMenu(tray, deps.labels(), deps.onShow, deps.onQuit)
    },

    setLoginItem(autoStart) {
      deps.applyLoginItem(loginItemSettings({ autoStart }))
    },

    onError: deps.onError
  }
}
