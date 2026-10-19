import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { RuntimeConfirmPromptPayload } from '@shared/contracts'
import { Modal } from './Modal'
import { useAppStore } from '../store'

const BRIDGE = window.dshHub

/**
 * 运行时二次确认浮层：dsh 下载（启动前）与系统默认 dsh 全局升级（公共空间）。
 * 主进程经 prompt broker 推送并等待回答；挂载时补拉待答快照，覆盖「事件早于订阅」的时序。
 * 关闭（Escape / 点背景 / 取消）一律按拒绝回答；主进程超时同样按拒绝处理。
 */
export default function RuntimeConfirmDialogs(): ReactNode {
  const t = useAppStore((state) => state.t)
  const workspaceOpen = useAppStore((state) => state.workspaceOpen)
  const workspaceOpening = useAppStore((state) => state.workspaceOpening)
  const modalScope = workspaceOpen || workspaceOpening ? ('workspace' as const) : ('app' as const)
  const [pending, setPending] = useState<RuntimeConfirmPromptPayload[]>([])

  useEffect(() => {
    if (!BRIDGE) return
    const merge = (items: RuntimeConfirmPromptPayload[]): void => {
      setPending((current) => {
        const known = new Set(current.map((item) => item.requestId))
        const added = items.filter((item) => !known.has(item.requestId))
        return added.length === 0 ? current : [...current, ...added]
      })
    }
    const unsubscribe = BRIDGE.runtime.onRuntimeConfirm((payload) => merge([payload]))
    // 快照补拉：推送事件可能早于本组件挂载（启动即需确认的场景）。
    void BRIDGE.runtime.listRuntimeConfirms().then((result) => {
      if (result.ok) merge(result.value)
    })
    return unsubscribe
  }, [])

  /** 回答一条确认：先出列再回复，Escape 与按钮竞速不会弹出下一条的重复回答。 */
  const answer = (requestId: string, accepted: boolean): void => {
    setPending((current) => current.filter((item) => item.requestId !== requestId))
    void BRIDGE?.runtime.replyRuntimeConfirm(requestId, accepted)
  }

  const prompt = pending[0]
  if (!prompt) return null

  const copy =
    prompt.kind === 'dsh-download'
      ? {
          title: t('runtime.confirm.downloadTitle'),
          body: t('runtime.confirm.downloadBody', { version: prompt.version }),
          // 下载来源必须可见：registry 自证完整性，用户要能确认包从哪里来。
          registry:
            prompt.registry !== ''
              ? t('runtime.confirm.downloadRegistry', { registry: prompt.registry })
              : t('runtime.confirm.downloadRegistryDefault'),
          hint: t('runtime.confirm.downloadHint'),
          accept: t('runtime.confirm.downloadAccept'),
          testId: 'runtime-confirm-download'
        }
      : {
          title: t('runtime.confirm.upgradeTitle'),
          body: t('runtime.confirm.upgradeBody', {
            latest: prompt.latest,
            current: prompt.current
          }),
          registry: null,
          hint: t('runtime.confirm.upgradeHint'),
          accept: t('runtime.confirm.upgradeAccept'),
          testId: 'runtime-confirm-upgrade'
        }

  return (
    <Modal
      closeLabel={t('common.close')}
      scope={modalScope}
      title={copy.title}
      onClose={() => answer(prompt.requestId, false)}
      testId="runtime-confirm-dialog"
      footer={
        <>
          <span className="meta">{copy.hint}</span>
          <div className="right">
            <button
              className="btn btn-secondary"
              data-testid="runtime-confirm-cancel"
              onClick={() => answer(prompt.requestId, false)}
            >
              {t('common.cancel')}
            </button>
            <button
              className="btn btn-primary"
              data-testid="runtime-confirm-accept"
              onClick={() => answer(prompt.requestId, true)}
            >
              {copy.accept}
            </button>
          </div>
        </>
      }
    >
      <p data-testid="runtime-confirm-body" style={{ fontSize: '12.5px', color: 'var(--muted)' }}>
        {copy.body}
      </p>
      {copy.registry !== null && (
        <p
          data-testid="runtime-confirm-registry"
          style={{ fontSize: '12px', color: 'var(--muted)' }}
        >
          {copy.registry}
        </p>
      )}
    </Modal>
  )
}
