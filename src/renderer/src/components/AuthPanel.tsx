import { useEffect, useState } from 'react'
import type { Dispatch, ReactNode, SetStateAction } from 'react'
import type { AuthSignalEvent, AuthStateEvent } from '@shared/contracts'
import {
  applyAuthSnapshot,
  applyAuthState,
  clearLock,
  closeAuthPanel,
  initialAuthPanelModel,
  lockRemaining,
  lockSeconds,
  openAuthPanel
} from '../lib/auth-panel-state'
import type { AuthPanelModel } from '../lib/auth-panel-state'
import { Icon } from '../lib/icons'
import { Modal } from './Modal'
import { useAppStore } from '../store'

const BRIDGE = window.dshHub

/** 实例名(信号只带 id;取不到时退化为 id 前缀) */
async function instanceNameOf(instanceId: string): Promise<string> {
  const list = await BRIDGE?.instances.list()
  if (list?.ok) {
    const found = list.value.find((item) => item.id === instanceId)
    if (found) return found.name
  }
  return instanceId.slice(0, 8)
}

/**
 * 在飞重探守卫:一个会话失效的页面会因多个子资源发出多条 `auth:signal`,
 * 没有守卫就会对同一实例并发打 N 次网关(并发闸只限流不合并)。
 */
const probing = new Set<string>()

/**
 * 打开认证面板后立即探测认证状态。
 * 状态快照返回前不渲染面板；已连接时归约会关闭面板。
 */
async function openAndProbe(
  instanceId: string,
  setModel: Dispatch<SetStateAction<AuthPanelModel>>
): Promise<void> {
  const name = await instanceNameOf(instanceId)
  setModel((current) => openAuthPanel(current, { id: instanceId, name }))
  if (probing.has(instanceId)) return
  probing.add(instanceId)
  try {
    const result = await BRIDGE?.auth.probe(instanceId)
    const value = result?.ok ? result.value : null
    if (value) setModel((current) => applyAuthSnapshot(current, instanceId, value))
  } finally {
    probing.delete(instanceId)
  }
}

/**
 * 认证面板。
 *
 * 状态流：
 *   needs-auth / await-credentials → 密码屏
 *   await-otp                     → 6 位验证码屏(可切备份码)
 *   锁定(lockedForMs>0)          → 倒计时,期间禁用提交
 *   onboarding                    → 引导(改初始密码在实例页面内完成)
 * 凭据只在提交时经 IPC 瞬时传递,不写 localStorage、不进日志。
 */
export default function AuthPanel(): ReactNode {
  // 面板状态经纯归约函数流转(auth-panel-state.ts):跨实例事件被忽略、锁定用绝对到期时刻
  const t = useAppStore((state) => state.t)
  const refreshVault = useAppStore((state) => state.refreshVault)
  const [model, setModel] = useState(initialAuthPanelModel)
  const [password, setPassword] = useState('')
  const [otpPassword, setOtpPassword] = useState('')
  const [otp, setOtp] = useState('')
  const [useBackup, setUseBackup] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 每秒 tick 只用于让「按到期时刻派生」的倒计时重算,不承载状态本身
  const [, setTick] = useState(0)
  // 已保存密码仅在用户选择记住密码且保险库中存在凭据时可用。
  // 主进程仍会验证此条件，渲染层不能绕过该检查。
  const [storedAvailable, setStoredAvailable] = useState(false)

  useEffect(() => {
    if (!BRIDGE) return
    return BRIDGE.auth.onState((event: AuthStateEvent) => {
      setModel((current) => applyAuthState(current, event))
      setError(null)
    })
  }, [])

  // 锁定倒计时:每秒重算剩余时间;到期后重探一次,让按钮与文案恢复。
  // 依赖收窄到锁定到期时刻与目标实例:仅锁定态变化才重建 interval，不随每次认证状态抖动。
  const lockUntil = model.lockUntil
  const lockTargetId = model.target?.id
  useEffect(() => {
    if (lockUntil === null) return
    const timer = setInterval(() => {
      setTick((value) => value + 1)
      if (Date.now() < lockUntil) return
      clearInterval(timer)
      // 到期时先解除锁定，再探测以刷新状态；探测失败不能使按钮保持禁用。
      setModel((current) => clearLock(current))
      if (!lockTargetId) return
      void BRIDGE?.auth.probe(lockTargetId).then((result) => {
        // 取局部常量:属性收窄不会跨进闭包
        const value = result?.ok ? result.value : null
        if (value) setModel((current) => applyAuthSnapshot(current, lockTargetId, value))
      })
    }, 1000)
    return () => clearInterval(timer)
  }, [lockUntil, lockTargetId])

  /** 供工作区浮层/详情页调用的入口(通过自定义事件打开) */
  useEffect(() => {
    const open = (event: Event): void => {
      const detail = (event as CustomEvent<{ id: string; name: string }>).detail
      setModel((current) => openAuthPanel(current, detail))
      void BRIDGE?.auth.probe(detail.id).then((result) => {
        const value = result?.ok ? result.value : null
        if (value) setModel((current) => applyAuthSnapshot(current, detail.id, value))
      })
    }
    window.addEventListener('dsh-hub:open-auth', open)
    return () => window.removeEventListener('dsh-hub:open-auth', open)
  }, [])

  /**
   * 认证信号表示会话失效、需要二次验证或需要引导时，打开面板并重新探测。
   */
  useEffect(() => {
    if (!BRIDGE) return
    return BRIDGE.auth.onSignal((event: AuthSignalEvent) => {
      const current = useAppStore.getState()
      // 工作区自己的登录页已经在右侧 WebContentsView 中呈现。认证信号通常
      // 会在导航后的异步探测中到达，此时若自动打开 Modal，fixed overlay 会覆盖整个 Hub。
      // 工作区关闭后，来自详情页/后台资源的信号仍可打开全局认证面板。
      if (current.workspaceOpen || current.workspaceOpening) return
      void openAndProbe(event.instanceId, setModel)
    })
  }, [])

  // 面板目标或认证相位变化时读取保险库状态，避免使用过期的已保存密码状态。
  const targetId = model.target?.id ?? null
  const targetPhase = model.state?.phase ?? null
  useEffect(() => {
    if (targetId === null || !BRIDGE) {
      setStoredAvailable(false)
      return
    }
    const instanceId = targetId
    let cancelled = false
    void BRIDGE.vault.status().then((result) => {
      if (cancelled) return
      if (!result.ok) {
        setStoredAvailable(false)
        return
      }
      const snapshot = result.value
      setStoredAvailable(
        snapshot.policies[instanceId]?.rememberPassword === true &&
          snapshot.rememberedInstances.includes(instanceId)
      )
    })
    return () => {
      cancelled = true
    }
  }, [targetId, targetPhase])

  // 面板关闭(含登录成功后的自动关闭)即丢弃已输入内容,避免密码在渲染层留存。
  useEffect(() => {
    if (targetId !== null && targetPhase !== null) return
    setPassword('')
    setOtpPassword('')
    setOtp('')
  }, [targetId, targetPhase])

  // OTP 屏的密码输入使用独立状态 otpPassword，避免与密码屏的 password 状态冲突。
  // effectivePassword 统一两种来源，供提交逻辑使用。
  const effectivePassword = password === '' ? otpPassword : password

  const target = model.target
  const state = model.state
  if (!target || !state) return null

  // 以「剩余时间」为准(而非仅看 lockUntil 是否存在):即使 tick 尚未执行也不会误判为锁死
  const locked = lockRemaining(model) > 0
  const lockedSeconds = lockSeconds(model)
  const phase = state.phase

  /**
   * 提交一次登录。`useStored` 为真时由主进程从保险库读取密码，
   * 密码不经过渲染层；为假时使用用户输入的密码。
   */
  const runLogin = async (useStored: boolean): Promise<void> => {
    if (!BRIDGE || busy || locked) return
    setBusy(true)
    setError(null)
    try {
      const code = otp === '' ? undefined : otp
      const result = useStored
        ? await BRIDGE.auth.loginStored(target.id, code)
        : await BRIDGE.auth.login(target.id, effectivePassword, code)
      const value = result.ok ? result.value : null
      if (value) setModel((current) => applyAuthSnapshot(current, target.id, value))
      else if (!result.ok) setError(result.message)
      // 登录成功时主进程已把密码写入保险库（写盘在 IPC 返回前完成），这里就地刷新
      // 「凭据存储」，否则详情页要等到重新挂载才显示「已记住」。
      if (value?.phase === 'connected') await refreshVault()
    } finally {
      setBusy(false)
      setOtp('')
    }
  }

  /** 主提交:验证码阶段密码留空时复用已存密码,其余情况使用输入的密码。 */
  const submit = (): Promise<void> =>
    runLogin(phase === 'await-otp' && effectivePassword === '' && storedAvailable)

  /** 显式入口:密码屏直接用已存密码登录,不要求用户输入。 */
  const submitStored = (): Promise<void> => runLogin(true)

  const close = (): void => {
    setModel(closeAuthPanel())
    setPassword('')
    setOtpPassword('')
    setOtp('')
    setError(null)
  }

  // 密码屏:needs-auth 与 await-credentials 都渲染(await-credentials 仅用于失败回退)
  const isPasswordPhase = phase !== 'await-otp'
  const title =
    phase === 'await-otp'
      ? t('auth.titleOtp')
      : phase === 'connected'
        ? t('auth.titleConnected')
        : t('auth.title')

  return (
    <Modal
      closeLabel={t('common.close')}
      title={title}
      sub={`${target.name} · ${phase}`}
      onClose={close}
      testId="auth-panel"
      footer={
        <>
          <span className="meta">
            {locked ? t('auth.locked', { seconds: lockedSeconds }) : t('auth.credentialsLocalOnly')}
          </span>
          <div className="right">
            {/* 紧凑浮层使用小尺寸操作按钮。 */}
            <button className="btn btn-secondary btn-sm" onClick={close}>
              {t('common.cancel')}
            </button>
            <button
              className="btn btn-primary btn-sm"
              data-testid="auth-submit"
              onClick={() => void submit()}
              // 验证码阶段需要验证码；没有可用的保存密码时也需要密码。
              disabled={
                busy ||
                locked ||
                (phase === 'await-otp'
                  ? otp === '' || (effectivePassword === '' && !storedAvailable)
                  : password === '')
              }
              title={
                phase === 'await-otp' && effectivePassword === '' && !storedAvailable
                  ? t('auth.needReusedPassword')
                  : phase === 'await-otp' && effectivePassword === '' && storedAvailable
                    ? t('auth.storedHint')
                    : undefined
              }
            >
              {busy
                ? t('auth.submitting')
                : locked
                  ? t('auth.lockButton', { seconds: lockedSeconds })
                  : phase === 'await-otp'
                    ? t('auth.submitOtp')
                    : t('auth.submit')}
            </button>
          </div>
        </>
      }
    >
      {state.needsOnboarding && (
        <div className="note n-warn" data-testid="auth-onboarding">
          <Icon name="alert" />
          <span>{t('auth.onboarding')}</span>
        </div>
      )}

      {state.message && (
        <div className="note n-err" data-testid="auth-message">
          <Icon name="alert" />
          <span>{state.message}</span>
        </div>
      )}

      {phase === 'await-otp' && password === '' && !storedAvailable && (
        <div className="field mt12">
          <label htmlFor="auth-password-otp">{t('auth.passwordForOtp')}</label>
          <input
            id="auth-password-otp"
            className="input"
            type="password"
            value={otpPassword}
            data-testid="auth-password-in-otp"
            onChange={(event) => setOtpPassword(event.target.value)}
          />
        </div>
      )}

      {isPasswordPhase ? (
        <>
          <div className="field mt12">
            <label htmlFor="auth-password">{t('auth.password')}</label>
            <input
              id="auth-password"
              className="input"
              type="password"
              autoFocus
              value={password}
              data-testid="auth-password"
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submit()
              }}
            />
          </div>
          {/* 密码留空时不必手输:由主进程用保险库中的密码完成登录。 */}
          {storedAvailable && (
            <button
              className="btn btn-secondary btn-sm mt12"
              data-testid="auth-use-stored"
              disabled={busy || locked}
              title={t('auth.useStoredHint')}
              onClick={() => void submitStored()}
            >
              <Icon name="shield" />
              {t('auth.useStoredPassword')}
            </button>
          )}
        </>
      ) : (
        <div className="field mt12">
          <label htmlFor="auth-otp">{useBackup ? t('auth.backupCode') : t('auth.otp')}</label>
          <input
            id="auth-otp"
            className="input num"
            autoFocus
            inputMode={useBackup ? 'text' : 'numeric'}
            value={otp}
            data-testid="auth-otp"
            onChange={(event) => setOtp(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submit()
            }}
          />
          <button
            className="btn btn-ghost btn-sm mt12"
            data-testid="auth-toggle-backup"
            onClick={() => {
              setUseBackup((value) => !value)
              setOtp('')
            }}
          >
            {useBackup ? t('auth.useOtp') : t('auth.useBackup')}
          </button>
        </div>
      )}

      {phase === 'await-otp' && storedAvailable && (
        <div className="hintbar mt12" data-testid="auth-stored-hint">
          <Icon name="shield" />
          <span>{t('auth.storedHint')}</span>
        </div>
      )}

      {state.otpEnabled && phase !== 'await-otp' && (
        <div className="hintbar mt12">
          <Icon name="shield" />
          <span>{t('auth.otpHint')}</span>
        </div>
      )}

      {/* 仅在网关要求验证码时显示此提示。 */}
      {phase === 'await-otp' && (
        <div className="hintbar mt12" data-testid="auth-otp-required-hint">
          <Icon name="shield" />
          <span>{t('auth.otpRequiredHint')}</span>
        </div>
      )}

      {error && (
        <div className="note n-err mt12">
          <Icon name="alert" />
          <span>{error}</span>
        </div>
      )}
    </Modal>
  )
}
