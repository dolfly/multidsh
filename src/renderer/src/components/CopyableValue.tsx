import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Translator } from '@shared/i18n'
import { Icon } from '../lib/icons'

/**
 * 可点击复制的值：hover/聚焦露出复制图标，复制成功后短暂显示「已复制」。
 * 反馈就地展示，不占版面、不弹 toast；剪贴板不可用时不切换反馈，避免显示假的「已复制」。
 */
export function CopyableValue(props: { t: Translator; value: string; testId?: string }): ReactNode {
  const { t, value, testId } = props
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current)
    },
    []
  )

  /** 点击复制展示值；剪贴板写入失败时不切换反馈。 */
  const copy = (): void => {
    void navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(true)
        if (copyTimer.current !== null) clearTimeout(copyTimer.current)
        copyTimer.current = setTimeout(() => setCopied(false), 1600)
      })
      .catch(() => undefined)
  }

  return (
    <button
      type="button"
      className="copyable"
      title={t('common.copy')}
      data-copied={copied ? 'true' : undefined}
      data-testid={testId}
      onClick={copy}
    >
      <span className="copyable-value">{value}</span>
      <span className="copyable-tail" role="status">
        {copied ? (
          <>
            <Icon name="check" size={11} /> {t('common.copied')}
          </>
        ) : (
          <Icon name="copy" size={11} />
        )}
      </span>
    </button>
  )
}
