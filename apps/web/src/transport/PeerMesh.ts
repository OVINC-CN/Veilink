import type { Member } from '../models'

export interface PeerSignalPayload {
  description?: RTCSessionDescriptionInit
  candidate?: RTCIceCandidateInit
}

interface PeerRecord {
  connection: RTCPeerConnection
  channel?: RTCDataChannel
  pendingCandidates: RTCIceCandidateInit[]
  ready: boolean
}

export interface PeerMeshOptions {
  localMemberId: string
  iceServers: RTCIceServer[]
  sendSignal: (targetMemberId: string, payload: PeerSignalPayload) => void
  onData: (sourceMemberId: string, data: string | ArrayBuffer) => void
  onConnectionChange?: (memberId: string, state: RTCPeerConnectionState) => void
  onChannelChange?: (memberId: string, state: RTCDataChannelState) => void
}

const MAX_PENDING_CANDIDATES = 64

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
  private knownMembers: Member[] = []
  private iceServers: RTCIceServer[]

  constructor(private readonly options: PeerMeshOptions) {
    this.iceServers = turnOnlyServers(options.iceServers)
    if (this.iceServers.length === 0) throw new Error('Cloudflare TURN credentials are required')
  }

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
        void this.createOffer(memberId, peer).catch(() => this.failPeer(memberId, peer))
      }
    }
  }

  async handleSignal(sourceMemberId: string, payload: PeerSignalPayload): Promise<void> {
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
      .filter(([memberId]) => this.options.localMemberId.localeCompare(memberId) < 0)
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
    const connection = new RTCPeerConnection(rtcConfiguration(this.iceServers))
    const peer: PeerRecord = { connection, pendingCandidates: [], ready: false }
    this.peers.set(memberId, peer)
    connection.addEventListener('icecandidate', (event) => {
      if (!event.candidate) return
      const candidate = event.candidate.toJSON()
      if (relayCandidate(candidate)) this.options.sendSignal(memberId, { candidate })
    })
    connection.addEventListener('datachannel', (event) => this.attachChannel(memberId, peer, event.channel))
    connection.addEventListener('connectionstatechange', () => {
      this.options.onConnectionChange?.(memberId, connection.connectionState)
      if (connection.connectionState === 'failed') this.failPeer(memberId, peer)
      if (connection.connectionState === 'closed' && this.peers.get(memberId) === peer) this.removePeer(memberId)
    })
    return peer
  }

  private attachChannel(memberId: string, peer: PeerRecord, channel: RTCDataChannel): void {
    peer.channel?.close()
    peer.channel = channel
    peer.ready = false
    channel.binaryType = 'arraybuffer'
    channel.addEventListener('open', () => {
      peer.ready = true
      this.options.onChannelChange?.(memberId, 'open')
      void selectedPairIsExplicitlyNonRelay(peer.connection).then((invalid) => {
        if (invalid && this.peers.get(memberId) === peer) this.failPeer(memberId, peer)
      })
    })
    channel.addEventListener('close', () => {
      peer.ready = false
      this.options.onChannelChange?.(memberId, channel.readyState)
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
}
