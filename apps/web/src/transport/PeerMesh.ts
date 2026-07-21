import type { Member } from '../models'

export interface PeerSignalPayload {
  description?: RTCSessionDescriptionInit
  candidate?: RTCIceCandidateInit
}

interface PeerRecord {
  connection: RTCPeerConnection
  channel?: RTCDataChannel
  pendingCandidates: RTCIceCandidateInit[]
  directVerified: boolean
  verification?: Promise<void>
}

export interface PeerMeshOptions {
  localMemberId: string
  iceServers: RTCIceServer[]
  sendSignal: (targetMemberId: string, payload: PeerSignalPayload) => void
  onData: (sourceMemberId: string, data: string | ArrayBuffer) => void
  onConnectionChange?: (memberId: string, state: RTCPeerConnectionState) => void
  onChannelChange?: (memberId: string, state: RTCDataChannelState) => void
}

const DIRECT_CANDIDATE_TYPES = new Set(['host', 'srflx', 'prflx'])
const MAX_PENDING_CANDIDATES = 64

function stunOnlyServers(servers: RTCIceServer[]): RTCIceServer[] {
  return servers.flatMap((server) => {
    const urls = (Array.isArray(server.urls) ? server.urls : [server.urls])
      .filter((url): url is string => typeof url === 'string' && url.startsWith('stun:') && !/\s/u.test(url))
    return urls.length === 0 ? [] : [{ urls }]
  })
}

function rtcConfiguration(options: PeerMeshOptions): RTCConfiguration {
  return {
    iceServers: stunOnlyServers(options.iceServers),
    iceTransportPolicy: 'all',
    bundlePolicy: 'max-bundle',
  }
}

function candidateType(candidate: string): string | undefined {
  if (/[\0\r\n]/u.test(candidate)) return undefined
  const matches = [...candidate.matchAll(/(?:^|\s)typ\s+(host|srflx|prflx|relay)(?=\s|$)/giu)]
  return matches.length === 1 ? matches[0]?.[1]?.toLowerCase() : undefined
}

function directCandidate(candidate: RTCIceCandidateInit): boolean {
  if (!candidate.candidate) return true
  const type = candidateType(candidate.candidate)
  return type !== undefined && DIRECT_CANDIDATE_TYPES.has(type)
}

function directDescription(description: RTCSessionDescriptionInit): boolean {
  if (!description.sdp) return description.type === 'rollback'
  const candidateLines = description.sdp
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('a=candidate:'))
  return candidateLines.every((line) => {
    const type = candidateType(line)
    return type !== undefined && DIRECT_CANDIDATE_TYPES.has(type)
  })
}

function sleep(delay: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delay))
}

function statString(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === 'string' ? record[key] : undefined
}

async function verifySelectedDirectPair(connection: RTCPeerConnection): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (connection.connectionState === 'failed' || connection.connectionState === 'closed') return false
    const records = new Map<string, Record<string, unknown>>()
    const report = await connection.getStats()
    report.forEach((entry) => records.set(entry.id, entry as unknown as Record<string, unknown>))

    let selectedPair: Record<string, unknown> | undefined
    for (const record of records.values()) {
      if (record.type === 'transport') {
        const pairId = statString(record, 'selectedCandidatePairId')
        if (pairId) selectedPair = records.get(pairId)
      }
    }
    if (!selectedPair) {
      selectedPair = [...records.values()].find((record) =>
        record.type === 'candidate-pair' &&
        record.state === 'succeeded' &&
        (record.nominated === true || record.selected === true),
      )
    }
    if (selectedPair) {
      const local = records.get(statString(selectedPair, 'localCandidateId') ?? '')
      const remote = records.get(statString(selectedPair, 'remoteCandidateId') ?? '')
      const localType = local ? statString(local, 'candidateType') : undefined
      const remoteType = remote ? statString(remote, 'candidateType') : undefined
      if (localType && remoteType) {
        return DIRECT_CANDIDATE_TYPES.has(localType) && DIRECT_CANDIDATE_TYPES.has(remoteType)
      }
    }
    await sleep(250)
  }
  return false
}

export class PeerMesh {
  private readonly peers = new Map<string, PeerRecord>()
  private knownMembers: Member[] = []

  constructor(private readonly options: PeerMeshOptions) {}

  syncMembers(members: Member[]): void {
    this.knownMembers = [...members]
    const remoteIds = new Set(members.map((member) => member.id).filter((id) => id !== this.options.localMemberId))
    for (const memberId of this.peers.keys()) {
      if (!remoteIds.has(memberId)) this.removePeer(memberId)
    }
    for (const memberId of remoteIds) {
      if (!this.peers.has(memberId) && this.options.localMemberId.localeCompare(memberId) < 0) {
        const peer = this.createPeer(memberId)
        const channel = peer.connection.createDataChannel('veilink', { ordered: true })
        this.attachChannel(memberId, peer, channel)
        void this.createOffer(memberId, peer)
      }
    }
  }

  async handleSignal(sourceMemberId: string, payload: PeerSignalPayload): Promise<void> {
    if (payload.description && !directDescription(payload.description)) throw new Error('Relayed or malformed ICE description rejected')
    if (payload.candidate && !directCandidate(payload.candidate)) throw new Error('Relayed or malformed ICE candidate rejected')
    const peer = this.peers.get(sourceMemberId) ?? this.createPeer(sourceMemberId)
    if (payload.description) {
      await peer.connection.setRemoteDescription(payload.description)
      for (const candidate of peer.pendingCandidates.splice(0)) await peer.connection.addIceCandidate(candidate)
      if (payload.description.type === 'offer') {
        const answer = await peer.connection.createAnswer()
        await peer.connection.setLocalDescription(answer)
        if (!directDescription(answer)) throw new Error('Browser produced a non-direct ICE answer')
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
  }

  connectedMemberIds(): string[] {
    return [...this.peers.entries()]
      .filter(([, peer]) => peer.directVerified && peer.channel?.readyState === 'open')
      .map(([memberId]) => memberId)
  }

  async broadcast(data: string | ArrayBuffer): Promise<number> {
    const channels = [...this.peers.values()]
      .filter((peer) => peer.directVerified)
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

  removePeer(memberId: string): void {
    const peer = this.peers.get(memberId)
    peer?.channel?.close()
    peer?.connection.close()
    this.peers.delete(memberId)
  }

  destroy(): void {
    for (const memberId of [...this.peers.keys()]) this.removePeer(memberId)
  }

  private createPeer(memberId: string): PeerRecord {
    const connection = new RTCPeerConnection(rtcConfiguration(this.options))
    const peer: PeerRecord = { connection, pendingCandidates: [], directVerified: false }
    this.peers.set(memberId, peer)
    connection.addEventListener('icecandidate', (event) => {
      if (!event.candidate) return
      const candidate = event.candidate.toJSON()
      if (directCandidate(candidate)) this.options.sendSignal(memberId, { candidate })
    })
    connection.addEventListener('datachannel', (event) => this.attachChannel(memberId, peer, event.channel))
    connection.addEventListener('connectionstatechange', () => {
      this.options.onConnectionChange?.(memberId, connection.connectionState)
      if (connection.connectionState === 'failed') {
        this.removePeer(memberId)
        window.setTimeout(() => this.syncMembers(this.knownMembers), 1_500)
      }
      if (connection.connectionState === 'closed') this.removePeer(memberId)
    })
    return peer
  }

  private attachChannel(memberId: string, peer: PeerRecord, channel: RTCDataChannel): void {
    peer.channel?.close()
    peer.channel = channel
    peer.directVerified = false
    channel.binaryType = 'arraybuffer'
    channel.addEventListener('open', () => {
      peer.verification ??= this.verifyChannel(memberId, peer)
    })
    channel.addEventListener('close', () => this.options.onChannelChange?.(memberId, channel.readyState))
    channel.addEventListener('message', (event: MessageEvent<string | ArrayBuffer>) => {
      if (peer.directVerified) this.options.onData(memberId, event.data)
    })
  }

  private async verifyChannel(memberId: string, peer: PeerRecord): Promise<void> {
    const direct = await verifySelectedDirectPair(peer.connection)
    if (this.peers.get(memberId) !== peer) return
    peer.verification = undefined
    if (!direct || peer.channel?.readyState !== 'open') {
      this.options.onConnectionChange?.(memberId, 'failed')
      this.removePeer(memberId)
      return
    }
    peer.directVerified = true
    this.options.onChannelChange?.(memberId, 'open')
  }

  private async createOffer(memberId: string, peer: PeerRecord, iceRestart = false): Promise<void> {
    const offer = await peer.connection.createOffer({ iceRestart })
    await peer.connection.setLocalDescription(offer)
    if (!directDescription(offer)) throw new Error('Browser produced a non-direct ICE offer')
    this.options.sendSignal(memberId, { description: offer })
  }
}
