import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_FILE_CHUNK_FRAME_BYTES } from '../protocol'
import type { Member } from '../models'
import {
  CONTROL_DATA_CHANNEL_LABEL,
  FILE_DATA_CHANNEL_LABEL,
  PeerMesh,
} from './PeerMesh'

class FakeDataChannel extends EventTarget {
  readonly id = 0
  readonly negotiated = false
  readonly protocol = ''
  readonly maxPacketLifeTime: number | null = null
  readonly maxRetransmits: number | null = null
  readyState: RTCDataChannelState = 'connecting'
  binaryType: BinaryType = 'blob'
  bufferedAmount = 0
  bufferedAmountLowThreshold = 0
  onbufferedamountlow: ((this: RTCDataChannel, ev: Event) => unknown) | null = null
  readonly sent: Array<string | ArrayBuffer> = []
  readonly sendErrors: unknown[] = []

  constructor(
    readonly label: string,
    readonly ordered: boolean,
  ) {
    super()
  }

  open(): void {
    this.readyState = 'open'
    this.dispatchEvent(new Event('open'))
  }

  close(): void {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    this.dispatchEvent(new Event('close'))
  }

  send(data: string | ArrayBuffer): void {
    const error = this.sendErrors.shift()
    if (error) throw error
    this.sent.push(data)
  }

  receive(data: string | ArrayBuffer): void {
    this.dispatchEvent(new MessageEvent('message', { data }))
  }
}

class FakePeerConnection extends EventTarget {
  static instances: FakePeerConnection[] = []

  readonly channels: FakeDataChannel[] = []
  readonly configuration: RTCConfiguration
  connectionState: RTCPeerConnectionState = 'new'
  iceConnectionState: RTCIceConnectionState = 'new'
  iceGatheringState: RTCIceGatheringState = 'new'
  signalingState: RTCSignalingState = 'stable'
  remoteDescription: RTCSessionDescription | null = null
  localDescription: RTCSessionDescription | null = null
  sctp: RTCSctpTransport | null = { maxMessageSize: 512 * 1024 } as RTCSctpTransport
  getStatsCalls = 0
  rttSeconds = 0.05
  bitrate = 16_000_000

  constructor(configuration: RTCConfiguration) {
    super()
    this.configuration = configuration
    FakePeerConnection.instances.push(this)
  }

  createDataChannel(label: string, options?: RTCDataChannelInit): RTCDataChannel {
    const channel = new FakeDataChannel(label, options?.ordered ?? true)
    this.channels.push(channel)
    return channel as unknown as RTCDataChannel
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'v=0\r\n' }
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'v=0\r\n' }
  }

  async setLocalDescription(description: RTCLocalSessionDescriptionInit): Promise<void> {
    this.localDescription = description as RTCSessionDescription
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description as RTCSessionDescription
  }

  async addIceCandidate(): Promise<void> {}

  setConfiguration(): void {}

  close(): void {
    this.connectionState = 'closed'
  }

  async getStats(): Promise<RTCStatsReport> {
    this.getStatsCalls += 1
    const records = new Map<string, Record<string, unknown>>([
      ['transport', { id: 'transport', type: 'transport', selectedCandidatePairId: 'pair' }],
      ['pair', {
        id: 'pair',
        type: 'candidate-pair',
        state: 'succeeded',
        nominated: true,
        localCandidateId: 'local',
        remoteCandidateId: 'remote',
        currentRoundTripTime: this.rttSeconds,
        availableOutgoingBitrate: this.bitrate,
        bytesSent: 123,
      }],
      ['local', { id: 'local', type: 'local-candidate', candidateType: 'relay' }],
      ['remote', { id: 'remote', type: 'remote-candidate', candidateType: 'relay' }],
    ])
    return records as unknown as RTCStatsReport
  }
}

const remoteMember: Member = {
  id: 'b',
  nickname: 'remote',
  identityPublicKey: 'key',
  joinedAt: 1,
  isOwner: false,
}

const meshes: PeerMesh[] = []

function createMesh(overrides: Partial<ConstructorParameters<typeof PeerMesh>[0]> = {}): PeerMesh {
  const mesh = new PeerMesh({
    localMemberId: 'a',
    iceServers: [
      { urls: 'stun:example.test' },
      { urls: ['turn:relay.example.test', 'stun:example.test'], username: 'user', credential: 'secret' },
    ],
    sendSignal: vi.fn(),
    onControlData: vi.fn(),
    onFileData: vi.fn(),
    ...overrides,
  })
  meshes.push(mesh)
  mesh.syncMembers([remoteMember])
  return mesh
}

function latestPeer(): FakePeerConnection {
  const connection = FakePeerConnection.instances.at(-1)
  if (!connection) throw new Error('Peer connection was not created')
  return connection
}

function channels(connection: FakePeerConnection): { control: FakeDataChannel; file: FakeDataChannel } {
  const control = connection.channels.find((channel) => channel.label === CONTROL_DATA_CHANNEL_LABEL)
  const file = connection.channels.find((channel) => channel.label === FILE_DATA_CHANNEL_LABEL)
  if (!control || !file) throw new Error('Expected both data channels')
  return { control, file }
}

beforeEach(() => {
  FakePeerConnection.instances = []
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection)
})

afterEach(() => {
  for (const mesh of meshes.splice(0)) mesh.destroy()
  vi.unstubAllGlobals()
})

describe('PeerMesh dual data channels', () => {
  it('creates TURN-only control and reliable unordered file channels', () => {
    const mesh = createMesh()
    const connection = latestPeer()
    const { control, file } = channels(connection)

    expect(connection.configuration.iceTransportPolicy).toBe('relay')
    expect(connection.configuration.iceServers).toEqual([
      { urls: ['turn:relay.example.test'], username: 'user', credential: 'secret', credentialType: 'password' },
    ])
    expect(control.ordered).toBe(true)
    expect(file.ordered).toBe(false)

    control.open()
    expect(mesh.connectedMemberIds()).toEqual(['b'])
    expect(mesh.fileCapability('b')).toMatchObject({ supported: false, reason: 'file-channel-not-open' })

    file.open()
    expect(mesh.fileCapability('b')).toEqual({
      supported: true,
      maxMessageSize: 512 * 1024,
      requiredMaxMessageSize: MAX_FILE_CHUNK_FRAME_BYTES,
    })
  })

  it('routes text and binary frames through independent handlers and buffers', async () => {
    const onControlData = vi.fn()
    const onFileData = vi.fn()
    const mesh = createMesh({ onControlData, onFileData })
    const { control, file } = channels(latestPeer())
    control.open()
    file.open()
    const frame = new ArrayBuffer(64)

    control.receive('control')
    file.receive(frame)
    expect(onControlData).toHaveBeenCalledWith('b', 'control')
    expect(onFileData).toHaveBeenCalledWith('b', frame)

    await expect(mesh.sendControl('b', 'outbound-control')).resolves.toBe(true)
    await expect(mesh.sendFile('b', frame)).resolves.toBe(true)
    expect(control.sent).toEqual(['outbound-control'])
    expect(file.sent).toEqual([frame])
    expect(control.bufferedAmountLowThreshold).toBe(128 * 1024)
    expect(file.bufferedAmountLowThreshold).toBeGreaterThanOrEqual(512 * 1024)
  })

  it('keeps chat ready while rejecting a negotiated 64 KiB file limit', async () => {
    const mesh = createMesh()
    const connection = latestPeer()
    connection.sctp = { maxMessageSize: 65_536 } as RTCSctpTransport
    const { control, file } = channels(connection)
    control.open()
    file.open()

    expect(mesh.connectedMemberIds()).toEqual(['b'])
    expect(mesh.fileCapability('b')).toEqual({
      supported: false,
      reason: 'max-message-size-too-small',
      maxMessageSize: 65_536,
      requiredMaxMessageSize: MAX_FILE_CHUNK_FRAME_BYTES,
    })
    await expect(mesh.sendControl('b', 'still works')).resolves.toBe(true)
    await expect(mesh.sendFile('b', new ArrayBuffer(1))).resolves.toBe(false)
  })

  it('caches transport stats and retries OperationError once', async () => {
    const mesh = createMesh()
    const connection = latestPeer()
    connection.rttSeconds = 0.2
    connection.bitrate = 1_000_000_000
    const { control, file } = channels(connection)
    control.open()
    file.open()
    await Promise.resolve()
    connection.getStatsCalls = 0
    file.sendErrors.push(new DOMException('busy', 'OperationError'))
    const frame = new ArrayBuffer(64)

    await expect(mesh.sendFile('b', frame)).resolves.toBe(true)
    await expect(mesh.sendFile('b', frame)).resolves.toBe(true)
    expect(connection.getStatsCalls).toBe(1)
    expect(file.sent).toEqual([frame, frame])
    expect(file.bufferedAmountLowThreshold).toBeLessThanOrEqual(4 * 1024 * 1024)
    expect(file.bufferedAmountLowThreshold).toBeGreaterThan(3 * 1024 * 1024)

    file.sendErrors.push(
      new DOMException('busy', 'OperationError'),
      new DOMException('still busy', 'OperationError'),
    )
    await expect(mesh.sendFile('b', frame)).resolves.toBe(false)
    expect(file.readyState).toBe('closed')
  })
})
