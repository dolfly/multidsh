import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { AskpassPromptPayload, HostKeyDecision, HostKeyPromptPayload } from '@shared/contracts'
import { Icon } from '../lib/icons'
import { Modal } from './Modal'
import { useAppStore } from '../store'

const BRIDGE = window.dshHub

/**
 * SSH 安全确认浮层。
 * 指纹变化时拒绝当前连接；用户可显式删除本地指纹后在下次连接时重新确认。
 * 口令仅通过 IPC 瞬时回传，不写入任何存储。
 */
export default function SshDialogs(): ReactNode {
  const t = useAppStore((state) => state.t)
  const workspaceOpen = useAppStore((state) => state.workspaceOpen)
  const workspaceOpening = useAppStore((state) => state.workspaceOpening)
  const toast = useAppStore((state) => state.toast)
  const modalScope = workspaceOpen || workspaceOpening ? ('workspace' as const) : ('app' as const)
  const [hostKey, setHostKey] = useState<HostKeyPromptPayload | null>(null)
  const [askpass, setAskpass] = useState<AskpassPromptPayload | null>(null)
  const [secret, setSecret] = useState('')
  /** 「忘记该主机指纹」的二次确认（独立于连接确认流程的破坏性恢复动作） */
  const [forgetFor, setForgetFor] = useState<{ instanceId: string; target: string } | null>(null)
  /** 恢复动作的桥接面：缺失时不渲染按钮（绝不出现点了没反应的死按钮） */
  const canForgetHostKey = typeof BRIDGE?.ssh.forgetHostKey === 'function'

  useEffect(() => {
    if (!BRIDGE) return
    const offHostKey = BRIDGE.ssh.onHostKeyDecision((payload) => setHostKey(payload))
    const offAskpass = BRIDGE.ssh.onAskpassRequest((payload) => {
      setSecret('')
      setAskpass(payload)
    })
    return () => {
      offHostKey()
      offAskpass()
    }
  }, [])

  const replyHostKey = (decision: HostKeyDecision): void => {
    if (!hostKey) return
    void BRIDGE?.ssh.replyHostKey(hostKey.requestId, decision)
    setHostKey(null)
  }

  const replyAskpass = (value: string | null): void => {
    if (!askpass) return
    void BRIDGE?.ssh.replyAskpass(askpass.requestId, value)
    setAskpass(null)
    setSecret('')
  }

  /**
   * 指纹变化的恢复入口：先明确**拒绝**本次连接（变化一律拒绝，绝不在连接流程里覆盖已信任
   * 指纹），再弹独立的破坏性确认框；忘记之后的下一次连接会重新走一遍首次 TOFU 确认。
   */
  const requestForgetHostKey = (): void => {
    if (!hostKey) return
    const { instanceId, target } = hostKey
    replyHostKey('reject')
    setForgetFor({ instanceId, target })
  }

  const confirmForgetHostKey = async (): Promise<void> => {
    if (!forgetFor || !BRIDGE) return
    const result = await BRIDGE.ssh.forgetHostKey({ instanceId: forgetFor.instanceId })
    if (!result.ok) {
      toast('err', t('ssh.forgetFailed'), result.message)
      return
    }
    toast('ok', t('ssh.forgetDone'))
    setForgetFor(null)
  }

  // 破坏性恢复动作的独立确认框：与连接确认分开，只删本机已信任指纹，不信任当前出示的公钥
  if (forgetFor) {
    return (
      <Modal
        closeLabel={t('common.close')}
        scope={modalScope}
        title={t('ssh.forgetTitle')}
        sub={forgetFor.target}
        onClose={() => setForgetFor(null)}
        testId="forget-host-key-dialog"
        footer={
          <>
            <span className="meta">{t('ssh.forgetIrreversible')}</span>
            <div className="right">
              <button className="btn btn-secondary" onClick={() => setForgetFor(null)}>
                {t('common.cancel')}
              </button>
              <button
                className="btn btn-danger"
                data-testid="forget-host-key-confirm"
                onClick={() => void confirmForgetHostKey()}
              >
                {t('ssh.forgetConfirm')}
              </button>
            </div>
          </>
        }
      >
        <div className="note n-err" data-testid="forget-host-key-warning">
          <Icon name="alert" />
          <span>{t('ssh.forgetBody')}</span>
        </div>
      </Modal>
    )
  }

  if (hostKey) {
    const changed = hostKey.verdict === 'changed'
    return (
      <Modal
        closeLabel={t('common.close')}
        scope={modalScope}
        wide
        title={changed ? t('ssh.hostKeyChangedTitle') : t('ssh.hostKeyTitle')}
        sub={`${hostKey.target} · ${changed ? t('ssh.hostKeyChangedSub') : t('ssh.hostKeyNewSub')}`}
        onClose={() => replyHostKey('reject')}
        testId="fingerprint-dialog"
        footer={
          <>
            <span className="meta">
              {changed ? t('ssh.hostKeyChangedHint') : t('ssh.hostKeyNewHint')}
            </span>
            <div className="right">
              <button className="btn btn-secondary" onClick={() => replyHostKey('reject')}>
                {changed ? t('common.close') : t('common.cancel')}
              </button>
              {changed ? (
                canForgetHostKey && (
                  // 指纹变化**没有**一键放行路径（主进程一律拒绝）。这里只提供显式、破坏性的
                  // 恢复动作：忘记本机已信任指纹后，下一次连接重新走首次确认。
                  <button
                    className="btn btn-danger"
                    data-testid="fingerprint-forget"
                    onClick={requestForgetHostKey}
                  >
                    {t('ssh.forgetHostKey')}
                  </button>
                )
              ) : (
                <button
                  className="btn btn-primary"
                  data-testid="fingerprint-accept"
                  onClick={() => replyHostKey('trust')}
                >
                  {t('ssh.trustAndConnect')}
                </button>
              )}
            </div>
          </>
        }
      >
        {changed ? (
          <div className="note n-err" data-testid="fingerprint-changed-warning">
            <Icon name="alert" />
            <span>
              <b>{t('ssh.hostKeyMismatch')}</b>
              {t('ssh.changedWarning')}
            </span>
          </div>
        ) : (
          <p style={{ fontSize: '12.5px', color: 'var(--muted)' }}>
            {t('ssh.untrustedHint', { target: hostKey.target })}
          </p>
        )}
        <div className="inset mt12">
          {hostKey.fingerprints.map((entry) => (
            <div className="fingerprint-row" key={entry.fingerprint}>
              <code className="num fingerprint-value">
                {entry.typeLabel} · {entry.fingerprint}
              </code>
              <button
                className="btn btn-ghost btn-sm fingerprint-copy"
                onClick={() => void navigator.clipboard.writeText(entry.fingerprint)}
              >
                <Icon name="copy" /> {t('common.copy')}
              </button>
            </div>
          ))}
          {changed && hostKey.previousFingerprints.length > 0 && (
            <div className="meta mt12" data-testid="fingerprint-previous">
              {t('ssh.previouslyTrusted')}
              {hostKey.previousFingerprints.map((entry) => entry.fingerprint).join(' · ')}
            </div>
          )}
        </div>
      </Modal>
    )
  }

  if (askpass) {
    return (
      <Modal
        closeLabel={t('common.close')}
        scope={modalScope}
        title={t('ssh.askpassTitle')}
        sub={askpass.prompt}
        onClose={() => replyAskpass(null)}
        testId="askpass-dialog"
        footer={
          <>
            <span className="meta">{t('ssh.askpassTransient')}</span>
            <div className="right">
              <button className="btn btn-secondary" onClick={() => replyAskpass(null)}>
                {t('common.cancel')}
              </button>
              <button
                className="btn btn-primary"
                data-testid="askpass-submit"
                onClick={() => replyAskpass(secret)}
                disabled={secret === ''}
              >
                {t('ssh.continue')}
              </button>
            </div>
          </>
        }
      >
        <div className="field">
          <label htmlFor="askpass-secret">{t('ssh.askpassLabel')}</label>
          <input
            id="askpass-secret"
            className="input"
            type="password"
            autoFocus
            value={secret}
            data-testid="askpass-input"
            onChange={(event) => setSecret(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && secret !== '') replyAskpass(secret)
            }}
          />
        </div>
      </Modal>
    )
  }

  return null
}
