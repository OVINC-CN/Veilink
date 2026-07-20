import type { RoomMode } from '@veilink/protocol'

const CANDIDATE_LINE_PATTERN = /^a=candidate:/u
const CANDIDATE_TYPE_VALUES = new Set(['host', 'srflx', 'prflx', 'relay'])

function candidateLines(sdp: string): string[] {
  return sdp
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => CANDIDATE_LINE_PATTERN.test(line))
}

function parseCandidateType(candidate: string): string | undefined {
  const normalized = candidate.trim().replace(/^a=/u, '')
  if (normalized === '') return ''
  const tokens = normalized.split(/\s+/u)
  if (
    tokens.length < 8 ||
    !tokens[0]?.startsWith('candidate:') ||
    tokens[0] === 'candidate:' ||
    !/^[12]$/u.test(tokens[1] ?? '') ||
    !/^(?:UDP|TCP)$/iu.test(tokens[2] ?? '') ||
    !/^\d+$/u.test(tokens[3] ?? '') ||
    !/^\d+$/u.test(tokens[5] ?? '') ||
    Number(tokens[5]) < 1 ||
    Number(tokens[5]) > 65_535 ||
    tokens[6] !== 'typ' ||
    !CANDIDATE_TYPE_VALUES.has(tokens[7] ?? '')
  ) {
    return undefined
  }
  if (tokens.slice(8).includes('typ')) return undefined
  return tokens[7]
}

function candidateAllowed(candidate: string, mode: RoomMode): boolean {
  const type = parseCandidateType(candidate)
  if (type === '') return true
  if (type === undefined) return false
  return mode === 'turn' ? type === 'relay' : type !== 'relay'
}

export function isRtcDescriptionAllowed(sdp: string, mode: RoomMode): boolean {
  return candidateLines(sdp).every((line) => candidateAllowed(line, mode))
}

export function isRtcCandidateAllowed(candidate: string, mode: RoomMode): boolean {
  return candidateAllowed(candidate.trim(), mode)
}
