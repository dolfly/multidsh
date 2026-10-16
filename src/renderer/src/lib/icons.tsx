/**
 * 线性图标集 —— 统一的 24×24 线性规范。
 * 保持笔触一致:fill=none / stroke=currentColor / stroke-width=1.6 / 圆角端点。
 */
import type { JSX } from 'react'

export type IconName =
  | 'hub'
  | 'local'
  | 'ssh'
  | 'remote'
  | 'search'
  | 'plus'
  | 'gear'
  | 'sun'
  | 'moon'
  | 'check'
  | 'alert'
  | 'info'
  | 'help'
  | 'lock'
  | 'shield'
  | 'key'
  | 'power'
  | 'external'
  | 'copy'
  | 'more'
  | 'close'
  | 'clock'
  | 'doc'
  | 'tray'
  | 'send'
  | 'link'
  | 'trash'
  | 'edit'
  | 'back'
  | 'refresh'
  | 'collapse'
  | 'expand'
  | 'wifi'
  | 'dots'
  | 'github'
  | 'sync'
  | 'folder'

const ICONS: Record<IconName, JSX.Element> = {
  hub: (
    <>
      <circle cx="12" cy="12" r="2.4" />
      <circle cx="4.8" cy="6" r="1.7" />
      <circle cx="19.2" cy="6" r="1.7" />
      <circle cx="4.8" cy="18" r="1.7" />
      <circle cx="19.2" cy="18" r="1.7" />
      <path d="M6.2 7.3l3.9 3.1M17.8 7.3l-3.9 3.1M6.2 16.7l3.9-3.1M17.8 16.7l-3.9-3.1" />
    </>
  ),
  local: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8.5 20h7M12 16v4" />
    </>
  ),
  ssh: (
    <>
      <rect x="2.5" y="4" width="19" height="16" rx="2" />
      <path d="M6.5 9.5l2.5 2.5-2.5 2.5M12.5 15H17" />
    </>
  ),
  remote: (
    <>
      <circle cx="12" cy="12" r="8.8" />
      <path d="M3.4 12h17.2M12 3.2c2.6 3.2 2.6 14.4 0 17.6M12 3.2c-2.6 3.2-2.6 14.4 0 17.6" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4 4" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  gear: (
    <>
      <path d="M20.65 9.92A8.9 8.9 0 0 1 20.65 14.08L17.83 13.40A6 6 0 0 1 16.13 16.35L18.13 18.46A8.9 8.9 0 0 1 14.53 20.53L13.70 17.75A6 6 0 0 1 10.30 17.75L9.47 20.53A8.9 8.9 0 0 1 5.87 18.46L7.87 16.35A6 6 0 0 1 6.17 13.40L3.35 14.08A8.9 8.9 0 0 1 3.35 9.92L6.17 10.60A6 6 0 0 1 7.87 7.65L5.87 5.54A8.9 8.9 0 0 1 9.47 3.47L10.30 6.25A6 6 0 0 1 13.70 6.25L14.53 3.47A8.9 8.9 0 0 1 18.13 5.54L16.13 7.65A6 6 0 0 1 17.83 10.60Z" />
      <circle cx="12" cy="12" r="3.15" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.6 5.6L7.2 7.2M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6" />
    </>
  ),
  moon: <path d="M20 14.6A8.6 8.6 0 1 1 9.4 4a6.9 6.9 0 0 0 10.6 10.6Z" />,
  check: <path d="M4.6 12.6l5 5 10-11.2" />,
  alert: (
    <>
      <path d="M12 4.4l8.6 15.2H3.4L12 4.4Z" />
      <path d="M12 10v4.2M12 17.2h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 11v5.2M12 7.8h.01" />
    </>
  ),
  // 问号圆圈：设置项说明入口，与 info 的「i」区分。
  help: (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M9.7 9.6a2.4 2.4 0 1 1 3.2 2.3c-.7.3-1 .9-1 1.6v.3" />
      <path d="M12 17.1h.01" />
    </>
  ),
  lock: (
    <>
      <rect x="4.6" y="10" width="14.8" height="9.8" rx="2" />
      <path d="M8 10V7.4a4 4 0 0 1 8 0V10" />
      <path d="M12 13.6v2.6" />
    </>
  ),
  shield: <path d="M12 3.4l7 2.5v6c0 4.4-3 7.6-7 8.7-4-1.1-7-4.3-7-8.7v-6l7-2.5Z" />,
  key: (
    <>
      <circle cx="8" cy="8" r="4.4" />
      <path d="M11.2 11.2L20 20M16.4 16.4l-2 2" />
    </>
  ),
  power: (
    <>
      <path d="M12 3.4v7.4" />
      <path d="M7.4 6.9a7 7 0 1 0 9.2 0" />
    </>
  ),
  external: (
    <>
      <path d="M14 4.5h5.5V10" />
      <path d="M19.5 4.5L11 13" />
      <path d="M18 14.6v4a1.6 1.6 0 0 1-1.6 1.6H5.1a1.6 1.6 0 0 1-1.6-1.6v-11a1.6 1.6 0 0 1 1.6-1.6h4" />
    </>
  ),
  copy: (
    <>
      <rect x="8.6" y="8.6" width="11" height="11" rx="2" />
      <path d="M15.4 8.6V6.6a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
    </>
  ),
  more: (
    <>
      <circle cx="5.4" cy="12" r="1.35" />
      <circle cx="12" cy="12" r="1.35" />
      <circle cx="18.6" cy="12" r="1.35" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6L6 18" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 7.4V12l3.2 2" />
    </>
  ),
  doc: (
    <>
      <path d="M7 3.5h7l4 4v13H7z" />
      <path d="M13.6 3.5v4.4H18" />
    </>
  ),
  tray: (
    <>
      <rect x="3" y="4.6" width="18" height="14.8" rx="2" />
      <path d="M3 13.4h5l1.4 2.4h5.2l1.4-2.4h5" />
    </>
  ),
  send: (
    <>
      <path d="M5 12h13M13 6.5l5.5 5.5L13 17.5" />
    </>
  ),
  link: (
    <>
      <path d="M9.6 14.4l4.8-4.8" />
      <path d="M13 7.6l1.6-1.6a3.6 3.6 0 0 1 5.1 5.1L18 12.7" />
      <path d="M11 16.4l-1.6 1.6a3.6 3.6 0 0 1-5.1-5.1L6 11.3" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 7h15M9.5 7V5.4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V7" />
      <path d="M6.5 7l.9 12a1 1 0 0 0 1 .9h7.2a1 1 0 0 0 1-.9L17.5 7" />
    </>
  ),
  edit: (
    <>
      <path d="M4.5 19.5h4L19 9a2.1 2.1 0 0 0-3-3L5.5 16.5z" />
      <path d="M14.5 7.5l2 2" />
    </>
  ),
  back: <path d="M14 6l-6 6 6 6" />,
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20 4v4h-4" />
    </>
  ),
  sync: (
    // 环形双向箭头：上弧顺时针、下弧逆时针，各带箭头，表示「检查更新 / 同步」。
    <>
      <path d="M4.8 12a7.2 7.2 0 0 1 12.3-5.1l1.9 1.9" />
      <path d="M19 4v4.8h-4.8" />
      <path d="M19.2 12a7.2 7.2 0 0 1-12.3 5.1l-1.9-1.9" />
      <path d="M5 20v-4.8h4.8" />
    </>
  ),
  collapse: (
    <>
      <path d="M14 5.5L7.5 12 14 18.5" />
      <path d="M18.5 5.5v13" />
    </>
  ),
  expand: (
    <>
      <path d="M10 5.5L16.5 12 10 18.5" />
      <path d="M5.5 5.5v13" />
    </>
  ),
  wifi: (
    <>
      <path d="M4.5 10.2a11 11 0 0 1 15 0" />
      <path d="M7.6 13.4a6.6 6.6 0 0 1 8.8 0" />
      <circle cx="12" cy="17" r="1" />
      <path d="M2.5 7.4a15 15 0 0 1 19 0" />
    </>
  ),
  dots: <path d="M4 12h.01M12 12h.01M20 12h.01" />,
  github: (
    // GitHub mark：填充型，显式 fill=currentColor 覆盖父级 fill=none，且关闭描边。
    <path
      fill="currentColor"
      stroke="none"
      d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.09.68-.22.68-.49 0-.24-.01-.87-.01-1.71-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.49-1.11-1.49-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.37-2.22-.26-4.55-1.14-4.55-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05a9.32 9.32 0 0 1 2.5-.34c.85 0 1.71.12 2.5.34 1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.81-4.57 5.06.36.32.68.94.68 1.9 0 1.37-.01 2.48-.01 2.82 0 .27.18.59.69.49A10.02 10.02 0 0 0 22 12.25C22 6.58 17.52 2 12 2z"
    />
  ),
  folder: (
    <>
      <path d="M3.5 6.8a1.6 1.6 0 0 1 1.6-1.6h3.4l1.8 2.1h8.6a1.6 1.6 0 0 1 1.6 1.6v8.7a1.6 1.6 0 0 1-1.6 1.6H5.1a1.6 1.6 0 0 1-1.6-1.6z" />
    </>
  )
}

/** 24×24 线性图标的 React 帮助函数。 */
export function Icon(props: { name: IconName; size?: number; className?: string }): JSX.Element {
  const { name, size = 16, className } = props
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {ICONS[name]}
    </svg>
  )
}