import { Icon } from '../lib/icons'
import { useAppStore } from '../store'

/** 右下角 Toast 堆栈 */
export default function Toasts(): React.ReactNode {
  const toasts = useAppStore((state) => state.toasts)
  if (toasts.length === 0) return null
  return (
    <div className="toasts" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast t-${toast.kind}`} data-testid="toast">
          <Icon
            name={
              toast.kind === 'ok'
                ? 'check'
                : toast.kind === 'err'
                  ? 'alert'
                  : toast.kind === 'warn'
                    ? 'alert'
                    : 'info'
            }
          />
          <div>
            <b>{toast.title}</b>
            {toast.detail && <p>{toast.detail}</p>}
          </div>
        </div>
      ))}
    </div>
  )
}
