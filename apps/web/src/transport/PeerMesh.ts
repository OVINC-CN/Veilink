import type { Member } from '../models'

export interface PeerSignalPayload {
  description?: RTCSessionDescriptionInit
  candidate?: RTCIceCandidateInit
}

export type PeerDiagnosticEvent =
  | {
    type: 'created'
    role: 'offerer' | 'answerer'
    connectionState: RTCPeerConnectionState
    iceConnectionState: RTCIceConnectionState
    iceGatheringState: RTCIceGatheringState
  }
  | { type: 'connection'; state: RTCPeerConnectionState }
  | { type: 'ice-connection'; state: RTCIceConnectionState }
  | { type: 'ice-gathering'; state: RTCIceGatheringState }
  | { type: 'channel'; state: RTCDataChannelState }
  | { type: 'error'; operation: string; error: Error }

interface PeerRecord {
  connection: RTCPeerConnection
  channel?: RTCDataChannel
  pendingCandidates: RTCIceCandidateInit[]
  ready: boolean
}

type PeerConnectionConstructor = typeof RTCPeerConnection

type LegacyPeerConnectionGlobal = typeof globalThis & {
  webkitRTCPeerConnection?: PeerConnectionConstructor
  mozRTCPeerConnection?: PeerConnectionConstructor
}

export interface PeerMeshOptions {
  localMemberId: string
  iceServers: RTCIceServer[]
  sendSignal: (targetMemberId: string, payload: PeerSignalPayload) => void
  onData: (sourceMemberId: string, data: string | ArrayBuffer) => void
  onConnectionChange?: (memberId: string, state: RTCPeerConnectionState) => void
  onChannelChange?: (memberId: string, state: RTCDataChannelState) => void
  onDiagnostic?: (memberId: string, event: PeerDiagnosticEvent) => void
}

const MAX_PENDING_CANDIDATES = 64

function resolvePeerConnectionConstructor(): PeerConnectionConstructor {
  const browserGlobal = globalThis as LegacyPeerConnectionGlobal
  const constructor = browserGlobal.RTCPeerConnection
    ?? browserGlobal.webkitRTCPeerConnection
    ?? browserGlobal.mozRTCPeerConnection
  if (!constructor) {
    throw new Error('当前浏览器未提供 WebRTC。请启用 WebRTC 功能，或更新浏览器/系统 WebView 后重试。')
  }
  return constructor
}

function localMemberOffers(localMemberId: string, remoteMemberId: string): boolean {
  return localMemberId < remoteMemberId
}

function turnOnlyServers(servers: RTCIceServer[]): RTCIceServer[] {
  return servers.flatMap((server) => {
    const urls = (Array.isArray(server.urls) ? server.urls : [server.urls])
      .filter((url): url is string => typeof url === 'string' && (url.startsWith('turn:') || url.startsWith('turns:')) && !/\s/u.test(url))
    if (urls.length === 0 || typeof server.username !== 'string' || typeof server.credential !== 'string') return []
    return [{ urls, username: server.username, credential: server.credential, credentialType: 'password' as const }]
  })
}

function rtcConfiguration(iceServers: RTCIceServer[]): RTCConfiguration {
  return {
    iceServers: turnOnlyServers(iceServers),
    iceTransportPolicy: 'relay',
    bundlePolicy: 'max-bundle',
  }
}

function candidateType(candidate: string): string | undefined {
  if (/[\0\r\n]/u.test(candidate)) return undefined
  const matches = [...candidate.matchAll(/(?:^|\s)typ\s+(host|srflx|prflx|relay)(?=\s|$)/giu)]
  return matches.length === 1 ? matches[0]?.[1]?.toLowerCase() : undefined
}

function relayCandidate(candidate: RTCIceCandidateInit): boolean {
  if (!candidate.candidate) return true
  return candidateType(candidate.candidate) === 'relay'
}

function relayDescription(description: RTCSessionDescriptionInit): boolean {
  if (!description.sdp) return description.type === 'rollback'
  return description.sdp
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('a=candidate:'))
    .every((line) => candidateType(line) === 'relay')
}

function statString(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === 'string' ? record[key] : undefined
}

async function selectedPairIsExplicitlyNonRelay(connection: RTCPeerConnection): Promise<boolean> {
  try {
    const records = new Map<string, Record<string, unknown>>()
    const report = await connection.getStats()
    report.forEach((entry) => records.set(entry.id, entry as unknown as Record<string, unknown>))
    let selectedPair: Record<string, unknown> | undefined
    for (const record of records.values()) {
      if (record.type !== 'transport') continue
      const pairId = statString(record, 'selectedCandidatePairId')
      if (pairId) selectedPair = records.get(pairId)
    }
    selectedPair ??= [...records.values()].find((record) =>
      record.type === 'candidate-pair' && record.state === 'succeeded' && (record.nominated === true || record.selected === true),
    )
    if (!selectedPair) return false
    const local = records.get(statString(selectedPair, 'localCandidateId') ?? '')
    const remote = records.get(statString(selectedPair, 'remoteCandidateId') ?? '')
    const localType = local ? statString(local, 'candidateType') : undefined
    const remoteType = remote ? statString(remote, 'candidateType') : undefined
    return (localType !== undefined && localType !== 'relay') || (remoteType !== undefined && remoteType !== 'relay')
  } catch {
    return false
  }
}

export class PeerMesh {
  private readonly peers = new Map<string, PeerRecord>()
  private readonly peerConnectionConstructor: PeerConnectionConstructor
  private knownMembers: Member[] = []
  private iceServers: RTCIceServer[]

  constructor(private readonly options: PeerMeshOptions) {
    this.iceServers = turnOnlyServers(options.iceServers)
    if (this.iceServers.length === 0) throw new Error('Cloudflare TURN credentials are required')
    this.peerConnectionConstructor = resolvePeerConnectionConstructor()
  }

  syncMembers(members: Member[]): void {
    this.knownMembers = [...members]
    const remoteIds = new Set(members.map((member) => member.id).filter((id) => id !== this.options.localMemberId))
    for (const memberId of this.peers.keys()) {
      if (!remoteIds.has(memberId)) this.removePeer(memberId)
    }
    for (const memberId of remoteIds) {
      if (!this.peers.has(memberId) && localMemberOffers(this.options.localMemberId, memberId)) {
        const peer = this.createPeer(memberId)
        const channel = peer.connection.createDataChannel('veilink', { ordered: true })
        this.attachChannel(memberId, peer, channel)
        void this.createOffer(memberId, peer).catch((error: unknown) => {
          this.reportError(memberId, 'create-offer', error)
          this.failPeer(memberId, peer)
        })
      }
    }
  }

  async handleSignal(sourceMemberId: string, payload: PeerSignalPayload): Promise<void> {
    try {
      if (payload.description && !relayDescription(payload.description)) throw new Error('Non-relay or malformed ICE description rejected')
      if (payload.candidate && !relayCandidate(payload.candidate)) throw new Error('Non-relay or malformed ICE candidate rejected')
      const peer = this.peers.get(sourceMemberId) ?? this.createPeer(sourceMemberId)
      if (payload.description) {
        await peer.connection.setRemoteDescription(payload.description)
        for (const candidate of peer.pendingCandidates.splice(0)) await peer.connection.addIceCandidate(candidate)
        if (payload.description.type === 'offer') {
          const answer = await peer.connection.createAnswer()
          await peer.connection.setLocalDescription(answer)
          if (!relayDescription(answer)) throw new Error('Browser produced a non-relay ICE answer')
          this.options.sendSignal(sourceMemberId, { description: answer })
        }
      }
      if (payload.candidate) {
        if (peer.connection.remoteDescription) await peer.connection.addIceCandidate(payload.candidate)
        else {
          if (peer.pendingCandidates.length >= MAX_PENDING_CANDIDATES) {
            this.removePeer(sourceMemberId)
            throw new Error('Too many ICE candidates arrived before the remote description')
          }
          peer.pendingCandidates.push(payload.candidate)
        }
      }
    } catch (error) {
      this.reportError(sourceMemberId, 'handle-signal', error)
      throw error
    }
  }

  connectedMemberIds(): string[] {
    return [...this.peers.entries()]
      .filter(([, peer]) => peer.ready && peer.channel?.readyState === 'open')
      .map(([memberId]) => memberId)
  }

  async broadcast(data: string | ArrayBuffer): Promise<number> {
    const channels = [...this.peers.values()]
      .filter((peer) => peer.ready)
      .map((peer) => peer.channel)
      .filter((channel): channel is RTCDataChannel => channel?.readyState === 'open')
    await Promise.all(channels.map(async (channel) => {
      if (channel.bufferedAmount > 4 * 1024 * 1024) {
        channel.bufferedAmountLowThreshold = 1024 * 1024
        await new Promise<void>((resolve) => channel.addEventListener('bufferedamountlow', () => resolve(), { once: true }))
      }
      if (typeof data === 'string') channel.send(data)
      else channel.send(data)
    }))
    return channels.length
  }

  async refreshIceServers(iceServers: RTCIceServer[]): Promise<void> {
    const next = turnOnlyServers(iceServers)
    if (next.length === 0) throw new Error('Cloudflare TURN credentials are required')
    this.iceServers = next
    for (const peer of this.peers.values()) peer.connection.setConfiguration(rtcConfiguration(this.iceServers))
    await Promise.all([...this.peers.entries()]
      .filter(([memberId]) => localMemberOffers(this.options.localMemberId, memberId))
      .map(async ([memberId, peer]) => this.createOffer(memberId, peer, true)))
  }

  removePeer(memberId: string): void {
    const peer = this.peers.get(memberId)
    this.peers.delete(memberId)
    peer?.channel?.close()
    peer?.connection.close()
  }

  destroy(): void {
    for (const memberId of [...this.peers.keys()]) this.removePeer(memberId)
  }

  private createPeer(memberId: string): PeerRecord {
    const connection = new this.peerConnectionConstructor(rtcConfiguration(this.iceServers))
    const peer: PeerRecord = { connection, pendingCandidates: [], ready: false }
    this.peers.set(memberId, peer)
    this.options.onDiagnostic?.(memberId, {
      type: 'created',
      role: localMemberOffers(this.options.localMemberId, memberId) ? 'offerer' : 'answerer',
      connectionState: connection.connectionState,
      iceConnectionState: connection.iceConnectionState,
      iceGatheringState: connection.iceGatheringState,
    })
    connection.addEventListener('icecandidate', (event) => {
      if (!event.candidate) return
      const candidate = event.candidate.toJSON()
      if (relayCandidate(candidate)) this.options.sendSignal(memberId, { candidate })
    })
    connection.addEventListener('datachannel', (event) => this.attachChannel(memberId, peer, event.channel))
    connection.addEventListener('connectionstatechange', () => {
      this.options.onDiagnostic?.(memberId, { type: 'connection', state: connection.connectionState })
      this.options.onConnectionChange?.(memberId, connection.connectionState)
      if (connection.connectionState === 'failed') {
        this.reportError(memberId, 'peer-connection', new Error('RTCPeerConnection failed'))
        this.failPeer(memberId, peer)
      }
      if (connection.connectionState === 'closed' && this.peers.get(memberId) === peer) this.removePeer(memberId)
    })
    connection.addEventListener('iceconnectionstatechange', () => {
      this.options.onDiagnostic?.(memberId, { type: 'ice-connection', state: connection.iceConnectionState })
      if (connection.iceConnectionState === 'failed') {
        this.reportError(memberId, 'ice-connection', new Error('ICE connection failed'))
        this.failPeer(memberId, peer)
      }
    })
    connection.addEventListener('icegatheringstatechange', () => {
      this.options.onDiagnostic?.(memberId, { type: 'ice-gathering', state: connection.iceGatheringState })
    })
    return peer
  }

  private attachChannel(memberId: string, peer: PeerRecord, channel: RTCDataChannel): void {
    peer.channel?.close()
    peer.channel = channel
    peer.ready = false
    channel.binaryType = 'arraybuffer'
    this.options.onDiagnostic?.(memberId, { type: 'channel', state: channel.readyState })
    channel.addEventListener('open', () => {
      peer.ready = true
      this.options.onDiagnostic?.(memberId, { type: 'channel', state: 'open' })
      this.options.onChannelChange?.(memberId, 'open')
      void selectedPairIsExplicitlyNonRelay(peer.connection).then((invalid) => {
        if (invalid && this.peers.get(memberId) === peer) {
          this.reportError(memberId, 'relay-policy-check', new Error('Selected ICE candidate pair is not relay-only'))
          this.failPeer(memberId, peer)
        }
      })
    })
    channel.addEventListener('close', () => {
      const closedBeforeReady = !peer.ready
      peer.ready = false
      this.options.onDiagnostic?.(memberId, { type: 'channel', state: channel.readyState })
      this.options.onChannelChange?.(memberId, channel.readyState)
      if (closedBeforeReady && this.peers.get(memberId) === peer && peer.channel === channel) {
        this.reportError(memberId, 'data-channel-closed', new Error('RTC data channel closed before opening'))
      }
    })
    channel.addEventListener('error', () => {
      this.reportError(memberId, 'data-channel', new Error('RTC data channel error'))
    })
    channel.addEventListener('message', (event: MessageEvent<string | ArrayBuffer>) => {
      if (peer.ready) this.options.onData(memberId, event.data)
    })
  }

  private failPeer(memberId: string, peer: PeerRecord): void {
    if (this.peers.get(memberId) !== peer) return
    this.options.onConnectionChange?.(memberId, 'failed')
    this.removePeer(memberId)
    window.setTimeout(() => this.syncMembers(this.knownMembers), 1_500)
  }

  private async createOffer(memberId: string, peer: PeerRecord, iceRestart = false): Promise<void> {
    const offer = await peer.connection.createOffer({ iceRestart })
    await peer.connection.setLocalDescription(offer)
    if (!relayDescription(offer)) throw new Error('Browser produced a non-relay ICE offer')
    this.options.sendSignal(memberId, { description: offer })
  }

  private reportError(memberId: string, operation: string, error: unknown): void {
    this.options.onDiagnostic?.(memberId, {
      type: 'error',
      operation,
      error: error instanceof Error ? error : new Error('Unknown WebRTC error'),
    })
  }
}
