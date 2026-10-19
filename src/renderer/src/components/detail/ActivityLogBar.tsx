import { useEffect, useRef, type ReactNode } from 'react'
import type { Translator } from '@shared/i18n'
import { Modal } from '../Modal'
import { formatActivity } from '../../lib/activity-format'
import type { ActivityLine } from '../../store'

export interface ActivityLogBarProps {
  t: Translator
  activity: ActivityLine[] | undefined
  showMore: boolean
  setShowMore: (value: boolean) => void
  onCopy: () => void
  onClear: () => void
  /** 打开本机实例的日志目录；仅本机实例提供，否则「更多」弹层不显示该按钮。 */
  onOpenLogDir?: () => void
}

/** 详情页底部活动信息栏：单行展示最新一条，「更多」弹层看历史并可复制/清空。 */
export default function ActivityLogBar(props: ActivityLogBarProps): ReactNode {
  const { t, activity, showMore, setShowMore, onCopy, onClear, onOpenLogDir } = props
  const logBodyRef = useRef<HTMLDivElement | null>(null)
  const logMoreRef = useRef<HTMLDivElement | null>(null)
  const latestLine = activity?.at(-1)

  // 信息栏固定单行：最新一条若本身含多行（如带换行的错误），只取最后一个非空行；
  // 过长再由 CSS 截断省略，不换行、不出滚动条。完整内容去「更多」弹层看。
  const latestText =
    latestLine !== undefined ? formatActivity(t, latestLine) : t('detail.log.empty')
  const singleLine =
    latestText
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line !== '')
      .at(-1) ?? latestText

  // 「更多」弹层：打开与新行到达时滚到最新。
  useEffect(() => {
    const element = logMoreRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [activity, showMore])

  return (
    <>
      <div className="detail-logbar" data-testid="detail-logbar">
        <div className="detail-logbar__body" ref={logBodyRef} data-testid="detail-logbar-body">
          <p className="detail-logbar__line num" title={singleLine}>
            {singleLine}
          </p>
        </div>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => setShowMore(true)}
          data-testid="detail-logbar-more"
        >
          {t('detail.log.more')}
        </button>
      </div>

      {showMore && (
        <Modal
          wide
          closeLabel={t('common.close')}
          title={t('detail.log.title')}
          onClose={() => setShowMore(false)}
          testId="log-more"
          closeButtonInTabOrder={false}
          footer={
            <div className="right">
              {onOpenLogDir && (
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={onOpenLogDir}
                  data-testid="log-more-open-dir"
                >
                  {t('detail.log.openDir')}
                </button>
              )}
              {latestLine !== undefined && (
                <>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={onCopy}
                    data-testid="log-more-copy"
                  >
                    {t('detail.log.copy')}
                  </button>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={onClear}
                    data-testid="log-more-clear"
                  >
                    {t('detail.log.clear')}
                  </button>
                </>
              )}
            </div>
          }
        >
          <div className="detail-logmore" ref={logMoreRef} data-testid="log-more-body">
            {activity === undefined || activity.length === 0 ? (
              <p className="meta">{t('detail.log.empty')}</p>
            ) : (
              activity.map((line) => (
                <p className="detail-logmore__line num" key={line.seq}>
                  {formatActivity(t, line)}
                </p>
              ))
            )}
          </div>
        </Modal>
      )}
    </>
  )
}
