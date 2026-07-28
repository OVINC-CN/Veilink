import type { Member } from '../models'
import { MAX_FILE_CHUNK_FRAME_BYTES, PEER_CONNECTION_WARNING_MS } from '../protocol'

export const CONTROL_DATA_CHANNEL_LABEL = 'veilink-control-v10'
export const FILE_DATA_CHANNEL_LABEL = 'veilink-file-v10'

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
  controlChannel?: RTCDataChannel
  fileChannel?: RTCDataChannel
  pendingCandidates: RTCIceCandidateInit[]
  ready: boolean
  fileLowWaterBytes: number
  statsSample?: { sampledAt: number; stats: PeerTransportStats }
  statsPromise?: Promise<PeerTransportStats>
  negotiationRetryTimer?: number
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
  onControlData?: (sourceMemberId: string, data: string) => void
  onFileData?: (sourceMemberId: string, data: ArrayBuffer) => void
  /** @deprecated Use onControlData and onFileData. */
  onData?: (sourceMemberId: string, data: string | ArrayBuffer) => void
  onConnectionChange?: (memberId: string, state: RTCPeerConnectionState) => void
  onChannelChange?: (memberId: string, state: RTCDataChannelState) => void
  onFileChannelChange?: (memberId: string, state: RTCDataChannelState) => void
  onFileCapabilityChange?: (memberId: string, capability: PeerFileCapability) => void
  onDiagnostic?: (memberId: string, event: PeerDiagnosticEvent) => void
}

export interface PeerTransportStats {
  rttMs?: number
  availableOutgoingBitrate?: number
  bytesSent?: number
}

export type PeerFileCapabilityReason =
  | 'peer-unavailable'
  | 'file-channel-unavailable'
  | 'file-channel-not-open'
  | 'file-channel-misconfigured'
  | 'sctp-unavailable'
  | 'max-message-size-unavailable'
  | 'max-message-size-too-small'
  | 'buffered-amount-low-unsupported'

export type PeerFileCapability =
  | {
    supported: true
    maxMessageSize: number
    requiredMaxMessageSize: number
  }
  | {
    supported: false
    reason: PeerFileCapabilityReason
    maxMessageSize?: number
    requiredMaxMessageSize: number
  }

const MAX_PENDING_CANDIDATES = 64
const CONTROL_BUFFER_HIGH_WATER_BYTES = 512 * 1024
const CONTROL_BUFFER_LOW_WATER_BYTES = 128 * 1024
const FILE_BUFFER_MIN_HIGH_WATER_BYTES = 1 * 1024 * 1024
const FILE_BUFFER_MAX_HIGH_WATER_BYTES = 8 * 1024 * 1024
const FILE_BUFFER_FALLBACK_HIGH_WATER_BYTES = 2 * 1024 * 1024
const TRANSPORT_STATS_CACHE_MS = 1_000

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
  private readonly peerRebuildTimers = new Set<number>()
  private readonly peerConnectionConstructor: PeerConnectionConstructor
  private knownMembers: Member[] = []
  private iceServers: RTCIceServer[]
  private destroyed = false

  constructor(private readonly options: PeerMeshOptions) {
    this.iceServers = turnOnlyServers(options.iceServers)
    if (this.iceServers.length === 0) throw new Error('Cloudflare TURN credentials are required')
    if (!options.onControlData && !options.onData) throw new Error('A control data handler is required')
    this.peerConnectionConstructor = resolvePeerConnectionConstructor()
  }

  syncMembers(members: Member[]): void {
    if (this.destroyed) return
    this.knownMembers = [...members]
    const remoteIds = new Set(members.map((member) => member.id).filter((id) => id !== this.options.localMemberId))
    for (const memberId of this.peers.keys()) {
      if (!remoteIds.has(memberId)) this.removePeer(memberId)
    }
    for (const memberId of remoteIds) {
      if (!this.peers.has(memberId) && localMemberOffers(this.options.localMemberId, memberId)) {
        const peer = this.createPeer(memberId)
        const controlChannel = peer.connection.createDataChannel(CONTROL_DATA_CHANNEL_LABEL, { ordered: true })
        const fileChannel = peer.connection.createDataChannel(FILE_DATA_CHANNEL_LABEL, { ordered: false })
        this.attachControlChannel(memberId, peer, controlChannel)
        this.attachFileChannel(memberId, peer, fileChannel)
        this.scheduleNegotiationRetry(memberId, peer)
        void this.createOffer(memberId, peer).catch((error: unknown) => {
          this.reportError(memberId, 'create-offer', error)
          this.failPeer(memberId, peer)
        })
      }
    }
  }

  async handleSignal(sourceMemberId: string, payload: PeerSignalPayload): Promise<void> {
    if (this.destroyed) return
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
      .filter(([, peer]) => peer.ready && peer.controlChannel?.readyState === 'open')
      .map(([memberId]) => memberId)
  }

  fileCapability(memberId: string): PeerFileCapability {
    const requiredMaxMessageSize = MAX_FILE_CHUNK_FRAME_BYTES
    const peer = this.peers.get(memberId)
    if (!peer) return { supported: false, reason: 'peer-unavailable', requiredMaxMessageSize }
    const channel = peer.fileChannel
    if (!channel) return { supported: false, reason: 'file-channel-unavailable', requiredMaxMessageSize }
    if (channel.ordered || channel.maxPacketLifeTime !== null || channel.maxRetransmits !== null) {
      return { supported: false, reason: 'file-channel-misconfigured', requiredMaxMessageSize }
    }
    if (channel.readyState !== 'open') return { supported: false, reason: 'file-channel-not-open', requiredMaxMessageSize }
    if (!('bufferedAmountLowThreshold' in channel) || !('onbufferedamountlow' in channel) || typeof channel.addEventListener !== 'function') {
      return { supported: false, reason: 'buffered-amount-low-unsupported', requiredMaxMessageSize }
    }
    const sctp = peer.connection.sctp
    if (!sctp) return { supported: false, reason: 'sctp-unavailable', requiredMaxMessageSize }
    const maxMessageSize = sctp.maxMessageSize
    if (typeof maxMessageSize !== 'number' || Number.isNaN(maxMessageSize) || maxMessageSize <= 0) {
      return { supported: false, reason: 'max-message-size-unavailable', requiredMaxMessageSize }
    }
    if (maxMessageSize < requiredMaxMessageSize) {
      return {
        supported: false,
        reason: 'max-message-size-too-small',
        maxMessageSize,
        requiredMaxMessageSize,
      }
    }
    return { supported: true, maxMessageSize, requiredMaxMessageSize }
  }

  async broadcastControl(data: string): Promise<number> {
    return await this.sendControlMany(this.connectedMemberIds(), data)
  }

  async sendControl(memberId: string, data: string): Promise<boolean> {
    const peer = this.peers.get(memberId)
    const channel = peer?.ready ? peer.controlChannel : undefined
    if (!channel || channel.readyState !== 'open') return false
    await this.waitForSendCapacity(channel, CONTROL_BUFFER_HIGH_WATER_BYTES, CONTROL_BUFFER_LOW_WATER_BYTES)
    if (channel.readyState !== 'open') return false
    channel.send(data)
    return true
  }

  async sendControlMany(memberIds: readonly string[], data: string): Promise<number> {
    const results = await Promise.all(memberIds.map((memberId) => this.sendControl(memberId, data)))
    return results.filter(Boolean).length
  }

  async sendFile(memberId: string, data: ArrayBuffer, chunkBytes = MAX_FILE_CHUNK_FRAME_BYTES): Promise<boolean> {
    const peer = this.peers.get(memberId)
    const capability = this.fileCapability(memberId)
    if (!peer?.ready || !capability.supported || data.byteLength > MAX_FILE_CHUNK_FRAME_BYTES || data.byteLength > capability.maxMessageSize) return false
    const channel = peer.fileChannel
    if (!channel) return false
    const normalizedChunkBytes = Number.isSafeInteger(chunkBytes) && chunkBytes > 0
      ? Math.min(chunkBytes, MAX_FILE_CHUNK_FRAME_BYTES)
      : MAX_FILE_CHUNK_FRAME_BYTES
    const stats = await this.transportStats(memberId)
    if (this.peers.get(memberId) !== peer || peer.fileChannel !== channel) return false
    const { highWaterBytes, lowWaterBytes } = this.fileBufferWatermarks(normalizedChunkBytes, stats)
    peer.fileLowWaterBytes = lowWaterBytes
    channel.bufferedAmountLowThreshold = lowWaterBytes
    try {
      await this.waitForSendCapacity(channel, highWaterBytes, lowWaterBytes, data.byteLength)
    } catch (error) {
      return this.failFileSend(memberId, peer, channel, error)
    }
    if (peer.fileChannel !== channel || !peer.ready || channel.readyState !== 'open') return false
    try {
      channel.send(data)
      return true
    } catch (error) {
      if (!this.isOperationError(error)) return this.failFileSend(memberId, peer, channel, error)
    }
    try {
      await this.waitForBufferedAmountLow(channel, lowWaterBytes)
      if (peer.fileChannel !== channel || !peer.ready || channel.readyState !== 'open') return false
      channel.send(data)
      return true
    } catch (error) {
      return this.failFileSend(memberId, peer, channel, error)
    }
  }

  async sendFileMany(memberIds: readonly string[], data: ArrayBuffer, chunkBytes = MAX_FILE_CHUNK_FRAME_BYTES): Promise<number> {
    const results = await Promise.all(memberIds.map((memberId) => this.sendFile(memberId, data, chunkBytes)))
    return results.filter(Boolean).length
  }

  async flushFile(memberIds: readonly string[]): Promise<void> {
    await Promise.all(memberIds.map(async (memberId) => {
      const peer = this.peers.get(memberId)
      const channel = peer?.fileChannel
      if (channel && channel.readyState === 'open' && channel.bufferedAmount > peer.fileLowWaterBytes) {
        await this.waitForBufferedAmountLow(channel, peer.fileLowWaterBytes)
      }
    }))
  }

  async transportStats(memberId: string): Promise<PeerTransportStats> {
    const peer = this.peers.get(memberId)
    if (!peer) return {}
    const now = Date.now()
    if (peer.statsSample && now - peer.statsSample.sampledAt < TRANSPORT_STATS_CACHE_MS) return peer.statsSample.stats
    if (peer.statsPromise) return await peer.statsPromise
    peer.statsPromise = this.collectTransportStats(peer.connection)
      .catch(() => ({}))
      .then((stats) => {
        peer.statsSample = { sampledAt: now, stats }
        return stats
      })
      .finally(() => {
        peer.statsPromise = undefined
      })
    return await peer.statsPromise
  }

  /** @deprecated Use broadcastControl for strings or sendFileMany for file frames. */
  async broadcast(data: string | ArrayBuffer): Promise<number> {
    return typeof data === 'string'
      ? await this.broadcastControl(data)
      : await this.sendFileMany(this.connectedMemberIds(), data)
  }

  /** @deprecated Use sendControl or sendFile. */
  async send(memberId: string, data: string | ArrayBuffer): Promise<boolean> {
    return typeof data === 'string'
      ? await this.sendControl(memberId, data)
      : await this.sendFile(memberId, data)
  }

  /** @deprecated Use sendControlMany or sendFileMany. */
  async sendMany(memberIds: readonly string[], data: string | ArrayBuffer): Promise<number> {
    return typeof data === 'string'
      ? await this.sendControlMany(memberIds, data)
      : await this.sendFileMany(memberIds, data)
  }

  /** @deprecated Use flushFile. */
  async flush(memberIds: readonly string[]): Promise<void> {
    await this.flushFile(memberIds)
  }

  private async collectTransportStats(connection: RTCPeerConnection): Promise<PeerTransportStats> {
    const records = new Map<string, Record<string, unknown>>()
    const report = await connection.getStats()
    report.forEach((entry) => records.set(entry.id, entry as unknown as Record<string, unknown>))
    let pair: Record<string, unknown> | undefined
    for (const record of records.values()) {
      if (record.type !== 'transport') continue
      const pairId = statString(record, 'selectedCandidatePairId')
      if (pairId) pair = records.get(pairId)
    }
    pair ??= [...records.values()].find((record) => record.type === 'candidate-pair' && record.state === 'succeeded' && (record.nominated === true || record.selected === true))
    if (!pair) return {}
    const rtt = typeof pair.currentRoundTripTime === 'number' ? pair.currentRoundTripTime : undefined
    const bitrate = typeof pair.availableOutgoingBitrate === 'number' ? pair.availableOutgoingBitrate : undefined
    const bytesSent = typeof pair.bytesSent === 'number' ? pair.bytesSent : undefined
    return {
      ...(rtt !== undefined ? { rttMs: Math.round(rtt * 1_000) } : {}),
      ...(bitrate !== undefined ? { availableOutgoingBitrate: bitrate } : {}),
      ...(bytesSent !== undefined ? { bytesSent } : {}),
    }
  }

  async refreshIceServers(iceServers: RTCIceServer[]): Promise<void> {
    if (this.destroyed) return
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
    if (peer?.negotiationRetryTimer !== undefined) window.clearTimeout(peer.negotiationRetryTimer)
    peer?.controlChannel?.close()
    peer?.fileChannel?.close()
    peer?.connection.close()
  }

  destroy(): void {
    this.destroyed = true
    for (const timer of this.peerRebuildTimers) window.clearTimeout(timer)
    this.peerRebuildTimers.clear()
    for (const memberId of [...this.peers.keys()]) this.removePeer(memberId)
  }

  private createPeer(memberId: string): PeerRecord {
    const connection = new this.peerConnectionConstructor(rtcConfiguration(this.iceServers))
    const peer: PeerRecord = {
      connection,
      pendingCandidates: [],
      ready: false,
      fileLowWaterBytes: FILE_BUFFER_FALLBACK_HIGH_WATER_BYTES / 2,
    }
    this.peers.set(memberId, peer)
    this.options.onDiagnostic?.(memberId, {
      type: 'created',
      role: localMemberOffers(this.options.localMemberId, memberId) ? 'offerer' : 'answerer',
      connectionState: connection.connectionState,
      iceConnectionState: connection.iceConnectionState,
      iceGatheringState: connection.iceGatheringState,
    })
    connection.addEventListener('icecandidate', (event) => {
      if (this.destroyed) return
      if (!event.candidate) return
      const candidate = event.candidate.toJSON()
      if (relayCandidate(candidate)) this.options.sendSignal(memberId, { candidate })
    })
    connection.addEventListener('datachannel', (event) => {
      if (this.destroyed) return
      if (event.channel.label === CONTROL_DATA_CHANNEL_LABEL) {
        this.attachControlChannel(memberId, peer, event.channel)
        return
      }
      if (event.channel.label === FILE_DATA_CHANNEL_LABEL) {
        this.attachFileChannel(memberId, peer, event.channel)
        return
      }
      event.channel.close()
      this.reportError(memberId, 'data-channel-label', new Error('Unsupported RTC data channel label'))
    })
    connection.addEventListener('connectionstatechange', () => {
      if (this.destroyed) return
      this.options.onDiagnostic?.(memberId, { type: 'connection', state: connection.connectionState })
      this.options.onConnectionChange?.(memberId, connection.connectionState)
      if (connection.connectionState === 'failed') {
        this.reportError(memberId, 'peer-connection', new Error('RTCPeerConnection failed'))
        this.failPeer(memberId, peer)
      }
      if (connection.connectionState === 'closed' && this.peers.get(memberId) === peer) this.removePeer(memberId)
    })
    connection.addEventListener('iceconnectionstatechange', () => {
      if (this.destroyed) return
      this.options.onDiagnostic?.(memberId, { type: 'ice-connection', state: connection.iceConnectionState })
      if (connection.iceConnectionState === 'failed') {
        this.reportError(memberId, 'ice-connection', new Error('ICE connection failed'))
        this.failPeer(memberId, peer)
      }
    })
    connection.addEventListener('icegatheringstatechange', () => {
      if (this.destroyed) return
      this.options.onDiagnostic?.(memberId, { type: 'ice-gathering', state: connection.iceGatheringState })
    })
    return peer
  }

  private attachControlChannel(memberId: string, peer: PeerRecord, channel: RTCDataChannel): void {
    if (peer.controlChannel === channel) return
    const previousChannel = peer.controlChannel
    peer.controlChannel = channel
    previousChannel?.close()
    peer.ready = false
    channel.binaryType = 'arraybuffer'
    channel.bufferedAmountLowThreshold = CONTROL_BUFFER_LOW_WATER_BYTES
    this.options.onDiagnostic?.(memberId, { type: 'channel', state: channel.readyState })
    channel.addEventListener('open', () => {
      if (this.destroyed || this.peers.get(memberId) !== peer || peer.controlChannel !== channel) return
      peer.ready = true
      if (peer.negotiationRetryTimer !== undefined) {
        window.clearTimeout(peer.negotiationRetryTimer)
        peer.negotiationRetryTimer = undefined
      }
      this.options.onDiagnostic?.(memberId, { type: 'channel', state: 'open' })
      this.options.onChannelChange?.(memberId, 'open')
      this.notifyFileCapability(memberId, peer)
      void selectedPairIsExplicitlyNonRelay(peer.connection).then((invalid) => {
        if (invalid && this.peers.get(memberId) === peer) {
          this.reportError(memberId, 'relay-policy-check', new Error('Selected ICE candidate pair is not relay-only'))
          this.failPeer(memberId, peer)
        }
      })
    })
    channel.addEventListener('close', () => {
      if (this.destroyed || this.peers.get(memberId) !== peer || peer.controlChannel !== channel) return
      const closedBeforeReady = !peer.ready
      peer.ready = false
      this.options.onDiagnostic?.(memberId, { type: 'channel', state: channel.readyState })
      this.options.onChannelChange?.(memberId, channel.readyState)
      if (closedBeforeReady) {
        this.reportError(memberId, 'control-channel-closed', new Error('RTC control data channel closed before opening'))
      }
    })
    channel.addEventListener('error', () => {
      if (this.destroyed || peer.controlChannel !== channel) return
      this.reportError(memberId, 'control-channel', new Error('RTC control data channel error'))
    })
    channel.addEventListener('message', (event: MessageEvent<string | ArrayBuffer>) => {
      if (this.destroyed || !peer.ready || peer.controlChannel !== channel) return
      if (typeof event.data !== 'string') {
        this.reportError(memberId, 'control-channel-data', new Error('RTC control data channel received non-text data'))
        return
      }
      if (this.options.onControlData) this.options.onControlData(memberId, event.data)
      else this.options.onData?.(memberId, event.data)
    })
  }

  private attachFileChannel(memberId: string, peer: PeerRecord, channel: RTCDataChannel): void {
    if (peer.fileChannel === channel) return
    const previousChannel = peer.fileChannel
    peer.fileChannel = channel
    previousChannel?.close()
    channel.binaryType = 'arraybuffer'
    if ('bufferedAmountLowThreshold' in channel) {
      channel.bufferedAmountLowThreshold = peer.fileLowWaterBytes
    }
    this.options.onFileChannelChange?.(memberId, channel.readyState)
    this.notifyFileCapability(memberId, peer)
    channel.addEventListener('open', () => {
      if (this.destroyed || this.peers.get(memberId) !== peer || peer.fileChannel !== channel) return
      this.options.onFileChannelChange?.(memberId, 'open')
      this.notifyFileCapability(memberId, peer)
    })
    channel.addEventListener('close', () => {
      if (this.destroyed || this.peers.get(memberId) !== peer || peer.fileChannel !== channel) return
      this.options.onFileChannelChange?.(memberId, channel.readyState)
      this.notifyFileCapability(memberId, peer)
    })
    channel.addEventListener('error', () => {
      if (this.destroyed || peer.fileChannel !== channel) return
      this.reportError(memberId, 'file-channel', new Error('RTC file data channel error'))
    })
    channel.addEventListener('message', (event: MessageEvent<string | ArrayBuffer>) => {
      if (this.destroyed || peer.fileChannel !== channel || channel.readyState !== 'open') return
      if (!(event.data instanceof ArrayBuffer)) {
        this.reportError(memberId, 'file-channel-data', new Error('RTC file data channel received non-binary data'))
        return
      }
      if (!this.fileCapability(memberId).supported) return
      if (this.options.onFileData) this.options.onFileData(memberId, event.data)
      else this.options.onData?.(memberId, event.data)
    })
  }

  private failPeer(memberId: string, peer: PeerRecord): void {
    if (this.peers.get(memberId) !== peer) return
    this.options.onConnectionChange?.(memberId, 'failed')
    this.removePeer(memberId)
    if (this.destroyed) return
    const timer = window.setTimeout(() => {
      this.peerRebuildTimers.delete(timer)
      if (!this.destroyed) this.syncMembers(this.knownMembers)
    }, 1_500)
    this.peerRebuildTimers.add(timer)
  }

  private async waitForSendCapacity(
    channel: RTCDataChannel,
    highWaterBytes: number,
    lowWaterBytes: number,
    pendingBytes = 0,
  ): Promise<void> {
    if (channel.bufferedAmount + pendingBytes <= highWaterBytes) return
    await this.waitForBufferedAmountLow(channel, lowWaterBytes)
  }

  private waitForBufferedAmountLow(channel: RTCDataChannel, lowWaterBytes: number): Promise<void> {
    if (channel.readyState !== 'open') return Promise.reject(new Error('RTC data channel is not open'))
    channel.bufferedAmountLowThreshold = lowWaterBytes
    if (channel.bufferedAmount <= lowWaterBytes) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        channel.removeEventListener('bufferedamountlow', onLow)
        channel.removeEventListener('close', onClose)
        channel.removeEventListener('error', onError)
      }
      const onLow = (): void => { cleanup(); resolve() }
      const onClose = (): void => { cleanup(); reject(new Error('RTC data channel closed while sending')) }
      const onError = (): void => { cleanup(); reject(new Error('RTC data channel failed while sending')) }
      channel.addEventListener('bufferedamountlow', onLow, { once: true })
      channel.addEventListener('close', onClose, { once: true })
      channel.addEventListener('error', onError, { once: true })
      if (channel.bufferedAmount <= lowWaterBytes) onLow()
    })
  }

  private fileBufferWatermarks(chunkBytes: number, stats: PeerTransportStats): { highWaterBytes: number; lowWaterBytes: number } {
    const bandwidthDelayProduct = stats.rttMs !== undefined && stats.rttMs > 0 &&
      stats.availableOutgoingBitrate !== undefined && stats.availableOutgoingBitrate > 0
      ? stats.availableOutgoingBitrate * stats.rttMs / 4_000
      : FILE_BUFFER_FALLBACK_HIGH_WATER_BYTES
    const minimumChunks = Math.ceil(FILE_BUFFER_MIN_HIGH_WATER_BYTES / chunkBytes)
    const maximumChunks = Math.max(minimumChunks, Math.floor(FILE_BUFFER_MAX_HIGH_WATER_BYTES / chunkBytes))
    const targetChunks = Math.ceil(bandwidthDelayProduct / chunkBytes)
    const boundedChunks = Math.min(maximumChunks, Math.max(minimumChunks, targetChunks))
    const highWaterBytes = boundedChunks * chunkBytes
    return {
      highWaterBytes,
      lowWaterBytes: Math.max(chunkBytes, Math.floor(highWaterBytes / 2)),
    }
  }

  private isOperationError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'name' in error && error.name === 'OperationError'
  }

  private failFileSend(memberId: string, peer: PeerRecord, channel: RTCDataChannel, error: unknown): false {
    this.reportError(memberId, 'file-channel-send', error)
    if (this.peers.get(memberId) === peer && peer.fileChannel === channel) channel.close()
    return false
  }

  private notifyFileCapability(memberId: string, peer: PeerRecord): void {
    if (this.peers.get(memberId) === peer) {
      this.options.onFileCapabilityChange?.(memberId, this.fileCapability(memberId))
    }
  }

  private scheduleNegotiationRetry(memberId: string, peer: PeerRecord): void {
    if (!localMemberOffers(this.options.localMemberId, memberId)) return
    peer.negotiationRetryTimer = window.setTimeout(() => {
      peer.negotiationRetryTimer = undefined
      if (this.peers.get(memberId) !== peer || peer.ready) return
      void this.createOffer(memberId, peer, true).catch((error: unknown) => {
        this.reportError(memberId, 'ice-restart', error)
        this.failPeer(memberId, peer)
      })
    }, PEER_CONNECTION_WARNING_MS)
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
