import { PROTOCOL_VERSION } from '../protocol'
import { ArrowRight, ArrowsClockwise, CaretDown, Check, CheckCircle, Circle, Copy, Key, ShieldCheck, SpinnerGap, WarningCircle, XCircle } from '@phosphor-icons/react'
import { useEffect, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from 'react'
import { t } from '../i18n'
import type { JoinAttempt, JoinFailure, JoinPeerDiagnostic, JoinStep, JoinStepId } from '../joinDiagnostics'
import type { Preferences } from '../preferences'
import { MemberAvatar } from './MemberAvatar'

interface JoinRoomViewProps {
  preferences: Preferences
  hasLinkSecret: boolean
  busy: boolean
  avatarSeed?: string
  avatarBusy: boolean
  restoring?: boolean
  error?: string
  joinAttempt?: JoinAttempt
  initialNickname?: string
  initialPin?: string
  onRegenerateAvatar: () => Promise<void> | void
  onJoin: (nickname: string, pin: string) => Promise<void> | void
  onEnter: () => void
}

const stepLabels: Record<'zh-CN' | 'en-US', Record<JoinStepId, string>> = {
  'zh-CN': {
    config: '读取服务器配置',
    keys: '派生本地加密密钥',
    signal: '连接信令服务器',
    challenge: '检查邀请并获取验证挑战',
    admission: '验证 PIN 并登记成员',
    turn: '获取 Cloudflare TURN 凭证',
    webrtc: '初始化仅中继 WebRTC',
    checkpoint: '保存安全恢复检查点',
    peers: '连接房间现有成员',
  },
  'en-US': {
    config: 'Read server configuration',
    keys: 'Derive local encryption keys',
    signal: 'Connect to the signaling server',
    challenge: 'Check invitation and request challenge',
    admission: 'Verify PIN and register member',
    turn: 'Request Cloudflare TURN credentials',
    webrtc: 'Initialize relay-only WebRTC',
    checkpoint: 'Save secure recovery checkpoint',
    peers: 'Connect to existing room members',
  },
}

const statusLabels = {
  'zh-CN': { pending: '等待', active: '进行中', success: '完成', failed: '失败', skipped: '无需执行' },
  'en-US': { pending: 'Waiting', active: 'In progress', success: 'Complete', failed: 'Failed', skipped: 'Not needed' },
} as const

const peerStatusLabels = {
  'zh-CN': { connecting: '连接中', ready: '已连接', left: '已离开，不再阻塞', failed: '连接失败' },
  'en-US': { connecting: 'Connecting', ready: 'Connected', left: 'Left; no longer blocking', failed: 'Connection failed' },
} as const

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.max(0, milliseconds)} ms`
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`
}

function elapsed(startedAt: number | undefined, finishedAt: number | undefined, now: number): string | undefined {
  if (startedAt === undefined) return undefined
  return formatDuration(Math.max(0, (finishedAt ?? now) - startedAt))
}

function failureCopy(failure: JoinFailure, locale: 'zh-CN' | 'en-US'): { title: string; suggestion: string } {
  const zh = locale === 'zh-CN'
  const retryMinutes = failure.retryAfterMs === undefined ? undefined : Math.max(1, Math.ceil(failure.retryAfterMs / 60_000))
  const copies: Record<string, { title: string; suggestion: string }> = {
    'server.room_not_found': { title: zh ? '邀请不可用' : 'Invitation unavailable', suggestion: zh ? '请确认邀请链接完整，或联系发起人获取新邀请。' : 'Check the complete invitation link or ask the host for a new one.' },
    'server.room_expired': { title: zh ? '邀请已经过期' : 'Invitation expired', suggestion: zh ? '请联系发起人创建新的临时会话。' : 'Ask the host to create a new temporary room.' },
    'server.room_full': { title: zh ? '房间人数已满' : 'Room is full', suggestion: zh ? '请等待其他成员退出后重试。' : 'Wait for another member to leave, then retry.' },
    'server.bad_proof': { title: zh ? 'PIN 验证未通过' : 'PIN verification failed', suggestion: zh ? '请核对通过其他渠道收到的 6 位 PIN。' : 'Check the six-digit PIN received through the other channel.' },
    'server.challenge_expired': { title: zh ? '入会验证已失效' : 'Admission challenge expired', suggestion: zh ? '直接重试，系统会获取新的验证挑战。' : 'Retry to request a fresh admission challenge.' },
    'server.rate_limited': { title: zh ? '尝试次数过多' : 'Too many attempts', suggestion: retryMinutes === undefined ? (zh ? '请稍后重试。' : 'Try again later.') : (zh ? `请等待约 ${retryMinutes} 分钟后重试。` : `Wait about ${retryMinutes} minute${retryMinutes === 1 ? '' : 's'} before retrying.`) },
    'server.turn_unavailable': { title: zh ? 'TURN 服务暂时不可用' : 'TURN service unavailable', suggestion: zh ? '请检查网络后重试；持续失败时请联系部署方检查 Cloudflare TURN。' : 'Check your network and retry; contact the operator if Cloudflare TURN remains unavailable.' },
    'server.internal_error': { title: zh ? '服务器处理失败' : 'Server processing failed', suggestion: zh ? '请重试；持续失败时请将诊断摘要提供给部署方。' : 'Retry; if it persists, share the diagnostic summary with the operator.' },
    'server.room_ended': { title: zh ? '房间已结束' : 'Room ended', suggestion: zh ? '请联系发起人确认房间状态或获取新邀请。' : 'Ask the host to confirm the room state or provide a new invitation.' },
    'client.config_unavailable': { title: zh ? '无法读取服务器配置' : 'Server configuration unavailable', suggestion: zh ? '请检查当前站点和网络连接后重试。' : 'Check this site and your network connection, then retry.' },
    'client.key_derivation_failed': { title: zh ? '无法派生本地密钥' : 'Local key derivation failed', suggestion: zh ? '请确认浏览器支持 Web Crypto，并重新检查 PIN。' : 'Confirm Web Crypto support and recheck the PIN.' },
    'client.signaling_failed': { title: zh ? '无法连接信令服务器' : 'Signaling connection failed', suggestion: zh ? '请检查 HTTPS/WSS 网络访问、防火墙或代理设置。' : 'Check HTTPS/WSS access, firewall, and proxy settings.' },
    'client.challenge_failed': { title: zh ? '无法获取入会验证' : 'Admission challenge failed', suggestion: zh ? '请检查邀请是否仍有效，然后重试。' : 'Check that the invitation is still valid, then retry.' },
    'client.admission_failed': { title: zh ? '无法完成入会验证' : 'Admission verification failed', suggestion: zh ? '请检查 PIN、房间状态和服务器响应后重试。' : 'Check the PIN, room state, and server response, then retry.' },
    'client.turn_setup_failed': { title: zh ? '无法获取 TURN 凭证' : 'TURN credentials could not be obtained', suggestion: zh ? '请检查网络；持续失败时请联系部署方检查 TURN 配置。' : 'Check the network; contact the operator if TURN configuration continues to fail.' },
    'client.webrtc_unavailable': { title: zh ? '浏览器未提供 WebRTC' : 'WebRTC is unavailable', suggestion: zh ? '请启用 WebRTC，或更新浏览器与系统 WebView。' : 'Enable WebRTC or update the browser and system WebView.' },
    'client.webrtc_initialization_failed': { title: zh ? 'WebRTC 初始化失败' : 'WebRTC initialization failed', suggestion: zh ? '请查看原始错误，确认浏览器和系统网络能力可用。' : 'Inspect the raw error and confirm browser and system networking support.' },
    'client.webrtc_signal_failed': { title: zh ? 'WebRTC 协商失败' : 'WebRTC negotiation failed', suggestion: zh ? '请根据成员级 ICE 与协商错误检查浏览器或网络限制。' : 'Use the peer ICE and negotiation error to check browser or network restrictions.' },
    'client.webrtc_operation_failed': { title: zh ? 'WebRTC 操作失败' : 'WebRTC operation failed', suggestion: zh ? '请展开成员详情查看失败操作和浏览器原始错误。' : 'Expand peer details for the failed operation and browser error.' },
    'client.relay_policy_rejected': { title: zh ? '连接不符合仅中继策略' : 'Relay-only policy rejected the connection', suggestion: zh ? '当前浏览器或网络没有建立合规的 TURN 中继路径。' : 'The browser or network did not establish a compliant TURN relay path.' },
    'client.peer_timeout': { title: zh ? '与房间成员连接超时' : 'Member connection timed out', suggestion: zh ? '展开成员状态检查 ICE/DataChannel；确认网络允许访问 Cloudflare TURN 后重试。' : 'Inspect ICE/DataChannel states below, allow Cloudflare TURN traffic, and retry.' },
    'client.peer_connection_failed': { title: zh ? '成员连接失败' : 'Peer connection failed', suggestion: zh ? '请展开成员状态检查具体失败环节后重试。' : 'Expand peer states to identify the failed stage, then retry.' },
    'client.checkpoint_failed': { title: zh ? '无法保存安全恢复检查点' : 'Secure checkpoint could not be saved', suggestion: zh ? '请检查浏览器存储权限或无痕模式限制。' : 'Check browser storage permissions or private-mode restrictions.' },
  }
  return copies[failure.code] ?? {
    title: zh ? '加入过程未能完成' : 'The join process could not complete',
    suggestion: zh ? '请根据失败步骤、错误码和成员状态排查后重试。' : 'Use the failed step, error code, and peer states below, then retry.',
  }
}

function stepStatusIcon(step: JoinStep) {
  if (step.status === 'active') return <SpinnerGap className="is-spinning" />
  if (step.status === 'success') return <CheckCircle weight="fill" />
  if (step.status === 'failed') return <XCircle weight="fill" />
  if (step.status === 'skipped') return <Check weight="bold" />
  return <Circle />
}

function diagnosticSummary(attempt: JoinAttempt, locale: 'zh-CN' | 'en-US', now: number): string {
  const zh = locale === 'zh-CN'
  const lines = [
    `Veilink join diagnostic (protocol v${PROTOCOL_VERSION})`,
    `${zh ? '开始时间' : 'Started'}: ${new Date(attempt.startedAt).toISOString()}`,
    `${zh ? '总耗时' : 'Elapsed'}: ${formatDuration((attempt.finishedAt ?? now) - attempt.startedAt)}`,
    '',
    zh ? '步骤' : 'Steps',
  ]
  for (const step of attempt.steps) {
    const duration = elapsed(step.startedAt, step.finishedAt, now)
    lines.push(`- ${stepLabels[locale][step.id]}: ${statusLabels[locale][step.status]}${duration ? ` (${duration})` : ''}`)
    if (step.code) lines.push(`  code: ${step.code}`)
    if (step.rawError) lines.push(`  error: ${step.rawError}`)
  }
  if (attempt.peers.length > 0) {
    lines.push('', zh ? '初始成员（标识已脱敏）' : 'Initial peers (identifiers redacted)')
    for (const peer of attempt.peers) {
      lines.push(`- ${peer.nickname} [${peer.memberIdHint}] ${peer.role} / ${peerStatusLabels[locale][peer.status]}`)
      lines.push(`  PC=${peer.connectionState} ICE=${peer.iceConnectionState} Gathering=${peer.iceGatheringState} DC=${peer.dataChannelState}`)
      if (peer.lastOperation) lines.push(`  operation: ${peer.lastOperation}`)
      if (peer.lastError) lines.push(`  error: ${peer.lastError}`)
    }
  }
  if (attempt.failure) {
    lines.push('', `${zh ? '最终错误码' : 'Final error code'}: ${attempt.failure.code}`)
  }
  return lines.join('\n')
}

function PeerDiagnosticRow({ peer, locale, now }: { peer: JoinPeerDiagnostic; locale: 'zh-CN' | 'en-US'; now: number }) {
  return (
    <li className={`join-peer is-${peer.status}`}>
      <div><strong>{peer.nickname}</strong><code>{peer.memberIdHint}</code><span>{peer.role}</span></div>
      <small>{peerStatusLabels[locale][peer.status]} · {elapsed(peer.startedAt, peer.finishedAt, now)}</small>
      <dl>
        <div><dt>PC</dt><dd>{peer.connectionState}</dd></div>
        <div><dt>ICE</dt><dd>{peer.iceConnectionState}</dd></div>
        <div><dt>Gathering</dt><dd>{peer.iceGatheringState}</dd></div>
        <div><dt>DataChannel</dt><dd>{peer.dataChannelState}</dd></div>
      </dl>
      {peer.lastError ? <p><code>{peer.lastOperation}</code>{peer.lastError}</p> : null}
    </li>
  )
}

function JoinProgress({ attempt, locale }: { attempt: JoinAttempt; locale: 'zh-CN' | 'en-US' }) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(Date.now())
  const zh = locale === 'zh-CN'

  useEffect(() => {
    if (attempt.finishedAt !== undefined) return
    const timer = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [attempt.finishedAt])

  useEffect(() => {
    setExpanded(false)
    setCopied(false)
    setNow(Date.now())
  }, [attempt.startedAt])

  useEffect(() => {
    if (attempt.failure) setExpanded(true)
  }, [attempt.failure])

  const active = attempt.steps.find((step) => step.status === 'active')
    ?? attempt.steps.find((step) => step.status === 'failed')
    ?? [...attempt.steps].reverse().find((step) => step.status === 'success' || step.status === 'skipped')
    ?? attempt.steps[0]
  const activeIndex = active ? attempt.steps.findIndex((step) => step.id === active.id) : 0
  const completed = attempt.finishedAt !== undefined
    && !attempt.failure
    && attempt.steps.every((step) => step.status === 'success' || step.status === 'skipped')
  const failure = attempt.failure ? failureCopy(attempt.failure, locale) : undefined
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(diagnosticSummary(attempt, locale, Date.now()))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_600)
    } catch {
      setCopied(false)
    }
  }

  return (
    <section className={`join-progress${attempt.failure ? ' has-failed' : ''}${completed ? ' is-complete' : ''}`} aria-label={zh ? '加入进度' : 'Join progress'}>
      <div className="join-progress-toolbar">
        <button className="join-progress-summary" type="button" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
          <span className="join-progress-icon">{attempt.failure ? <WarningCircle weight="fill" /> : completed ? <CheckCircle weight="fill" /> : <SpinnerGap className="is-spinning" />}</span>
          <span>
            <strong>{attempt.failure
              ? (zh ? `第 ${activeIndex + 1}/9 步失败` : `Failed at step ${activeIndex + 1}/9`)
              : completed
                ? (zh ? '连接建立完成' : 'Connection established')
                : (zh ? `第 ${activeIndex + 1}/9 步` : `Step ${activeIndex + 1}/9`)}</strong>
            <small>{completed
              ? `${zh ? '全部 9 个步骤已完成' : 'All 9 steps complete'} · ${formatDuration(attempt.finishedAt! - attempt.startedAt)}`
              : `${active ? stepLabels[locale][active.id] : ''} · ${formatDuration((attempt.finishedAt ?? now) - attempt.startedAt)}`}</small>
          </span>
          <CaretDown className="join-progress-caret" />
        </button>
        <button className="join-copy-button" type="button" aria-label={zh ? '复制诊断摘要' : 'Copy diagnostic summary'} title={zh ? '复制诊断摘要' : 'Copy diagnostic summary'} onClick={() => void copy()}>{copied ? <Check /> : <Copy />}</button>
      </div>

      {failure ? <div className="join-failure" role="alert"><strong>{failure.title}</strong><span>{failure.suggestion}</span><code>{attempt.failure?.code}</code></div> : null}

      {expanded ? (
        <div className="join-progress-details">
          <ol className="join-step-list">
            {attempt.steps.map((step) => (
              <li className={`is-${step.status}`} key={step.id}>
                <span className="join-step-icon">{stepStatusIcon(step)}</span>
                <span className="join-step-copy">
                  <strong>{stepLabels[locale][step.id]}</strong>
                  <small>{statusLabels[locale][step.status]}{elapsed(step.startedAt, step.finishedAt, now) ? ` · ${elapsed(step.startedAt, step.finishedAt, now)}` : ''}</small>
                  {step.code ? <code>{step.code}</code> : null}
                  {step.rawError ? <span className="join-raw-error">{step.rawError}</span> : null}
                </span>
              </li>
            ))}
          </ol>
          {attempt.peers.length > 0 ? (
            <section className="join-peer-details">
              <header><strong>{zh ? '初始成员连接' : 'Initial peer connections'}</strong><small>{zh ? '成员标识已脱敏' : 'Member identifiers are redacted'}</small></header>
              <ul>{attempt.peers.map((peer) => <PeerDiagnosticRow peer={peer} locale={locale} now={now} key={peer.memberIdHint} />)}</ul>
            </section>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

export function JoinRoomView({ preferences, hasLinkSecret, busy, avatarSeed, avatarBusy, restoring = false, error, joinAttempt, initialNickname, initialPin, onRegenerateAvatar, onJoin, onEnter }: JoinRoomViewProps) {
  const [nickname, setNickname] = useState(initialNickname ?? (preferences.rememberNickname ? preferences.nickname ?? '' : ''))
  const [digits, setDigits] = useState<string[]>(() => Array.from({ length: 6 }, (_, index) => initialPin?.[index] ?? ''))
  const inputs = useRef<Array<HTMLInputElement | null>>([])
  const resolvedNickname = initialNickname ?? nickname
  const resolvedDigits = /^\d{6}$/u.test(initialPin ?? '')
    ? Array.from({ length: 6 }, (_, index) => initialPin?.[index] ?? '')
    : digits
  const pin = resolvedDigits.join('')
  const ready = joinAttempt?.finishedAt !== undefined && !joinAttempt.failure
  const locked = busy || ready
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (ready) {
      onEnter()
      return
    }
    if (nickname.trim() && /^\d{6}$/u.test(pin) && hasLinkSecret) void onJoin(nickname, pin)
  }
  const setDigit = (index: number, rawValue: string): void => {
    const values = rawValue.replace(/\D/gu, '')
    if (!values) {
      setDigits((current) => current.map((digit, digitIndex) => digitIndex === index ? '' : digit))
      return
    }
    setDigits((current) => {
      const next = [...current]
      for (let offset = 0; offset < values.length && index + offset < next.length; offset += 1) {
        next[index + offset] = values[offset] ?? ''
      }
      return next
    })
    inputs.current[Math.min(5, index + values.length)]?.focus()
  }
  const handleKeyDown = (index: number, event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Backspace' && !digits[index] && index > 0) {
      event.preventDefault()
      setDigits((current) => current.map((digit, digitIndex) => digitIndex === index - 1 ? '' : digit))
      inputs.current[index - 1]?.focus()
    }
    if (event.key === 'ArrowLeft' && index > 0) {
      event.preventDefault()
      inputs.current[index - 1]?.focus()
    }
    if (event.key === 'ArrowRight' && index < 5) {
      event.preventDefault()
      inputs.current[index + 1]?.focus()
    }
  }
  const handlePaste = (event: ClipboardEvent<HTMLInputElement>): void => {
    const pasted = event.clipboardData.getData('text').replace(/\D/gu, '').slice(0, 6)
    if (!pasted) return
    event.preventDefault()
    setDigits(Array.from({ length: 6 }, (_, index) => pasted[index] ?? ''))
    inputs.current[Math.min(5, pasted.length)]?.focus()
  }

  return (
    <>
      <div className="entry-copy">
        <span className="entry-eyebrow"><ShieldCheck weight="fill" />{preferences.locale === 'zh-CN' ? '受保护的邀请' : 'Protected invitation'}</span>
        <h1>{t(preferences.locale, 'join')}</h1>
        <p>{restoring
          ? (preferences.locale === 'zh-CN' ? '正在恢复会话密钥并重新建立成员连接。' : 'Restoring session keys and re-establishing member connections.')
          : hasLinkSecret ? t(preferences.locale, 'joinDescription') : t(preferences.locale, 'linkMissing')}</p>
      </div>
      <form className="entry-form" onSubmit={submit}>
        <div className="avatar-picker">
          {avatarSeed ? <MemberAvatar seed={avatarSeed} label={t(preferences.locale, 'randomAvatar')} className="avatar-preview" /> : <span className="avatar-skeleton" aria-hidden="true" />}
          <div><strong>{t(preferences.locale, 'randomAvatar')}</strong><small>{t(preferences.locale, 'avatarEphemeral')}</small></div>
          <button type="button" className="avatar-refresh" disabled={locked || avatarBusy} onClick={() => void onRegenerateAvatar()}><ArrowsClockwise />{avatarBusy ? t(preferences.locale, 'avatarGenerating') : t(preferences.locale, 'changeAvatar')}</button>
        </div>
        <label>{t(preferences.locale, 'nickname')}<input autoFocus autoComplete="off" autoCapitalize="words" spellCheck="false" maxLength={64} type="text" value={resolvedNickname} placeholder={t(preferences.locale, 'nicknamePlaceholder')} disabled={locked} onChange={(event) => setNickname(event.target.value)} required /></label>
        <fieldset className="pin-fieldset" disabled={locked}>
          <legend>{t(preferences.locale, 'pin')}</legend>
          <div className="pin-inputs">
            {resolvedDigits.map((digit, index) => (
              <input
                key={index}
                ref={(element) => { inputs.current[index] = element }}
                aria-label={preferences.locale === 'zh-CN' ? `PIN 第 ${index + 1} 位` : `${t(preferences.locale, 'pinDigit')} ${index + 1}`}
                autoComplete="off"
                data-1p-ignore="true"
                enterKeyHint={index === 5 ? 'done' : 'next'}
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={1}
                type="text"
                value={digit}
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => setDigit(index, event.target.value)}
                onKeyDown={(event) => handleKeyDown(index, event)}
                onPaste={handlePaste}
              />
            ))}
          </div>
        </fieldset>
        {joinAttempt ? <JoinProgress attempt={joinAttempt} locale={preferences.locale} /> : null}
        {error && !joinAttempt?.failure ? <div className="form-error" role="alert">{error}</div> : null}
        <button className="primary-button" type="submit" disabled={!ready && (busy || avatarBusy || !avatarSeed || !hasLinkSecret || !resolvedNickname.trim() || !/^\d{6}$/u.test(pin))}>
          {ready ? <ArrowRight weight="bold" /> : <Key weight="fill" />}
          {ready ? t(preferences.locale, 'enter') : busy ? t(preferences.locale, 'connecting') : joinAttempt?.failure ? (preferences.locale === 'zh-CN' ? '重试加入' : 'Retry join') : t(preferences.locale, 'join')}
        </button>
      </form>
      <div className="privacy-callout entry-security"><ShieldCheck weight="fill" /><span>{preferences.locale === 'zh-CN' ? 'PIN 和链接密钥仅在本机派生 E2EE 密钥；服务器只接收域隔离的认证材料。' : 'The PIN and link secret derive E2EE keys only on this device; the server receives domain-separated authentication material.'}</span></div>
    </>
  )
}
