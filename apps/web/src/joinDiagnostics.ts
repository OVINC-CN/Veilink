export const JOIN_STEP_IDS = [
  'config',
  'keys',
  'signal',
  'challenge',
  'admission',
  'turn',
  'webrtc',
  'checkpoint',
  'peers',
] as const

export type JoinStepId = (typeof JOIN_STEP_IDS)[number]
export type JoinStepStatus = 'pending' | 'active' | 'success' | 'failed' | 'skipped'

export interface JoinStep {
  id: JoinStepId
  status: JoinStepStatus
  startedAt?: number
  finishedAt?: number
  code?: string
  rawError?: string
}

export interface JoinFailure {
  stepId: JoinStepId
  code: string
  rawError: string
  retryAfterMs?: number
}

export interface JoinPeerDiagnostic {
  memberIdHint: string
  nickname: string
  role: 'offerer' | 'answerer'
  status: 'connecting' | 'ready' | 'left' | 'failed'
  startedAt: number
  finishedAt?: number
  connectionState: RTCPeerConnectionState
  iceConnectionState: RTCIceConnectionState
  iceGatheringState: RTCIceGatheringState
  dataChannelState: RTCDataChannelState | 'pending'
  lastOperation?: string
  lastError?: string
}

export interface JoinAttempt {
  startedAt: number
  finishedAt?: number
  steps: JoinStep[]
  peers: JoinPeerDiagnostic[]
  failure?: JoinFailure
}

export function createJoinAttempt(now = Date.now()): JoinAttempt {
  return {
    startedAt: now,
    steps: JOIN_STEP_IDS.map((id) => ({ id, status: 'pending' })),
    peers: [],
  }
}

export function memberIdHint(memberId: string): string {
  if (memberId.length <= 8) return memberId
  return `${memberId.slice(0, 4)}…${memberId.slice(-4)}`
}

export function sanitizeDiagnosticText(value: unknown): string {
  const raw = value instanceof Error ? value.message : typeof value === 'string' ? value : String(value)
  return raw
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, '[redacted-ip]')
    .replace(/\b(?:[a-f\d]{0,4}:){2,}[a-f\d:%._-]+\b/giu, '[redacted-ip]')
    .replace(/(?:turns?|stun):[^\s"']+/giu, '[redacted-relay-url]')
    .replace(/[\r\n\t]+/gu, ' ')
    .trim()
    .slice(0, 512) || 'Unknown error'
}
