import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { HttpAuthDetection } from '@shared/contracts'
import type { MessageKey } from '@shared/i18n/messages'
import { useAppStore } from '../store'
import { Icon } from '../lib/icons'
import type { IconName } from '../lib/icons'

const BRIDGE = window.dshHub

/**
 * 远程端点的认证模式探测。
 * 探测为只读操作，不写注册表也不携带凭据。
 */

/** 认证模式对应的文案只保存 key，由调用方翻译。 */
const MODE_COPY: Record<
  HttpAuthDetection['mode'],
  { tone: string; icon: IconName; textKey: MessageKey }
> = {
  gateway: { tone: 'n-ok', icon: 'check', textKey: 'detect.gateway' },
  none: { tone: 'n-ok', icon: 'check', textKey: 'detect.none' },
  'browser-auth': { tone: 'n-info', icon: 'shield', textKey: 'detect.browserAuth' },
  unreachable: { tone: 'n-warn', icon: 'alert', textKey: 'detect.unreachable' },
  unknown: { tone: 'n-warn', icon: 'info', textKey: 'detect.unknown' }
}

export default function UrlDetect(props: { endpointUrl: string }): ReactNode {
  const t = useAppStore((state) => state.t)
  const [detection, setDetection] = useState<HttpAuthDetection | null>(null)
  // 运行期错误直接显示，本地兜底文案使用 key，避免语言变化后重新探测。
  const [error, setError] = useState<string | null>(null)
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null)
  const url = props.endpointUrl.trim()

  useEffect(() => {
    if (!BRIDGE || url === '') {
      setDetection(null)
      setError(null)
      setErrorKey(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      void BRIDGE.http
        .detect(url)
        .then((result) => {
          if (cancelled) return
          if (result.ok) {
            setDetection(result.value)
            setError(null)
            setErrorKey(null)
            setErrorKey(null)
          } else {
            setDetection(null)
            setError(result.message)
          }
        })
        .catch(() => {
          if (!cancelled) setErrorKey('detect.failed')
        })
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [url])

  if (url === '') {
    return (
      <div className="hintbar" data-testid="url-detect-hint">
        <Icon name="link" />
        <span>{t('detect.hint')}</span>
      </div>
    )
  }
  const errorText = error ?? (errorKey === null ? null : t(errorKey))
  if (errorText !== null) {
    return (
      <div className="note n-warn" data-testid="url-detect-error">
        <Icon name="alert" />
        <span>{errorText}</span>
      </div>
    )
  }
  if (!detection) {
    return (
      <div className="hintbar" data-testid="url-detect-loading">
        <Icon name="link" />
        <span>{t('detect.probing')}</span>
      </div>
    )
  }
  const copy = MODE_COPY[detection.mode]
  return (
    <div className={`note ${copy.tone}`} data-testid={`url-detect-${detection.mode}`}>
      <Icon name={copy.icon} />
      <span>
        {t(copy.textKey)}
        <span className="meta"> · {detection.evidence}</span>
      </span>
    </div>
  )
}
