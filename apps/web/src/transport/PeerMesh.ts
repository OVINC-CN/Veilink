import type { Member } from '../models'

export interface IceCredentials {
  urls: string[]
  username?: string
  credential?: string
}

export interface PeerSignalPayload {
  description?: RTCSessionDescriptionInit
  candidate?: RTCIceCandidateInit
}

interface PeerRecord {
  connection: RTCPeerConnection
  channel?: RTCDataChannel
  pendingCandidates: RTCIceCandidateInit[]
}

export interface PeerMeshOptions {
  localMemberId: string
  turnCredentials: IceCredentials
  sendSignal: (targetMemberId: string, payload: PeerSignalPayload) => void
  onData: (sourceMemberId: string, data: string | ArrayBuffer) => void
  onConnectionChange?: (memberId: string, state: RTCPeerConnectionState) => void
  onChannelChange?: (memberId: string, state: RTCDataChannelState) => void
}

function rtcConfiguration(options: PeerMeshOptions): RTCConfiguration {
  return {
    iceServers: [{
      urls: options.turnCredentials.urls,
      ...(options.turnCredentials.username ? { username: options.turnCredentials.username } : {}),
      ...(options.turnCredentials.credential ? { credential: options.turnCredentials.credential } : {}),
    }],
    iceTransportPolicy: 'relay',
    bundlePolicy: 'max-bundle',
  }
}

export class PeerMesh {
  private readonly peers = new Map<string, PeerRecord>()
  private knownMembers: Member[] = []
  private options: PeerMeshOptions

  constructor(options: PeerMeshOptions) {
    this.options = options
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
        void this.createOffer(memberId, peer)
      }
    }
  }

  async handleSignal(sourceMemberId: string, payload: PeerSignalPayload): Promise<void> {
    const peer = this.peers.get(sourceMemberId) ?? this.createPeer(sourceMemberId)
    if (payload.description) {
      await peer.connection.setRemoteDescription(payload.description)
      for (const candidate of peer.pendingCandidates.splice(0)) {
        await peer.connection.addIceCandidate(candidate)
      }
      if (payload.description.type === 'offer') {
        const answer = await peer.connection.createAnswer()
        await peer.connection.setLocalDescription(answer)
        this.options.sendSignal(sourceMemberId, { description: answer })
      }
    }
    if (payload.candidate) {
      if (peer.connection.remoteDescription) await peer.connection.addIceCandidate(payload.candidate)
      else peer.pendingCandidates.push(payload.candidate)
    }
  }

  connectedMemberIds(): string[] {
    return [...this.peers.entries()]
      .filter(([, peer]) => peer.channel?.readyState === 'open')
      .map(([memberId]) => memberId)
  }

  async broadcast(data: string | ArrayBuffer): Promise<number> {
    const channels = [...this.peers.values()]
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

  async refreshTurnCredentials(turnCredentials: IceCredentials): Promise<void> {
    this.options = { ...this.options, turnCredentials }
    for (const [memberId, peer] of this.peers) {
      peer.connection.setConfiguration(rtcConfiguration(this.options))
      if (this.options.localMemberId.localeCompare(memberId) < 0) {
        peer.connection.restartIce()
        await this.createOffer(memberId, peer, true)
      }
    }
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
    const peer: PeerRecord = { connection, pendingCandidates: [] }
    this.peers.set(memberId, peer)
    connection.addEventListener('icecandidate', (event) => {
      if (event.candidate) this.options.sendSignal(memberId, { candidate: event.candidate.toJSON() })
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
    channel.binaryType = 'arraybuffer'
    channel.addEventListener('open', () => this.options.onChannelChange?.(memberId, channel.readyState))
    channel.addEventListener('close', () => this.options.onChannelChange?.(memberId, channel.readyState))
    channel.addEventListener('message', (event: MessageEvent<string | ArrayBuffer>) => this.options.onData(memberId, event.data))
  }

  private async createOffer(memberId: string, peer: PeerRecord, iceRestart = false): Promise<void> {
    const offer = await peer.connection.createOffer({ iceRestart })
    await peer.connection.setLocalDescription(offer)
    this.options.sendSignal(memberId, { description: offer })
  }
}
