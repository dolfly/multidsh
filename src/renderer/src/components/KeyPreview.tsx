import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { SshKeyPreviewResult } from '@shared/contracts'
import { useAppStore } from '../store'
import { Icon } from '../lib/icons'
import type { MessageKey } from '@shared/i18n/messages'

const BRIDGE = window.dshHub

/**
 * SSH 密钥的只读预览。
 * 仅显示路径和公钥元信息，绝不读取或显示私钥内容。
 */
export default function KeyPreview(props: {
  host: string
  username: string
  sshPort: string
}): ReactNode {
  const t = useAppStore((state) => state.t)
  const [preview, setPreview] = useState<SshKeyPreviewResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 本地兜底文案走 key(effect 因此不依赖 t);主进程返回的运行期文案照旧直显
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null)
  const host = props.host.trim()
  const username = props.username.trim()
  const port = Number(props.sshPort) || 22

  useEffect(() => {
    if (!BRIDGE || host === '' || username === '') {
      setPreview(null)
      setError(null)
      setErrorKey(null)
      return
    }
    let cancelled = false
    // 输入停顿后再解析,避免每次按键都派生 ssh -G / ssh-add
    const timer = setTimeout(() => {
      void BRIDGE.ssh
        .keyPreview({ host, port, username })
        .then((result) => {
          if (cancelled) return
          if (result.ok) {
            setPreview(result.value)
            setError(null)
            setErrorKey(null)
          } else {
            setPreview(null)
            setError(result.message)
          }
        })
        .catch(() => {
          if (!cancelled) setErrorKey('keyPreview.failed')
        })
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [host, username, port])

  if (host === '') {
    return (
      <div className="hintbar" data-testid="key-preview-hint">
        <Icon name="key" />
        <span>{t('keyPreview.hint')}</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="note n-warn" data-testid="key-preview-error">
        <Icon name="alert" />
        <span>{error ?? (errorKey === null ? '' : t(errorKey))}</span>
      </div>
    )
  }

  if (!preview) {
    return (
      <div className="hintbar" data-testid="key-preview-loading">
        <Icon name="key" />
        <span>{t('keyPreview.resolving')}</span>
      </div>
    )
  }

  const agentReady = preview.agent.status === 'ready'
  const agentKey = preview.agent.keys[0]
  const firstIdentity = preview.identityFiles[0]
  const hasUsableKey = agentReady || preview.identityFiles.length > 0

  if (!hasUsableKey) {
    return (
      <div className="note n-warn" data-testid="key-preview-empty">
        <Icon name="alert" />
        <span>
          {t('keyPreview.none', {
            agent:
              preview.agent.status === 'unavailable'
                ? t('keyPreview.agentUnavailable')
                : t('keyPreview.agentEmpty')
          })}
        </span>
      </div>
    )
  }

  return (
    <div className="note n-ok" data-testid="key-preview-ok">
      <Icon name="key" />
      <span>
        {t('keyPreview.using')}
        <span className="num">
          {agentReady && agentKey
            ? `${agentKey.typeLabel} (ssh-agent${agentKey.comment ? ` · ${agentKey.comment}` : ''})`
            : (firstIdentity ?? t('keyPreview.defaultKey'))}
        </span>
        {preview.identityFiles.length > 1 && (
          <span className="meta">
            {' '}
            · {t('keyPreview.alternates', { n: preview.identityFiles.length - 1 })}
          </span>
        )}
        {preview.explicitIdentityFile && (
          <span className="meta"> · {t('keyPreview.explicit')}</span>
        )}
      </span>
    </div>
  )
}
