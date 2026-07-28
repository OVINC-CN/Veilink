export const TERMINAL_FILE_GRACE_MS = 30_000
export const TERMINAL_FILE_GRACE_BYTES = 8 * 1024 * 1024

export interface TerminalFileGraceBudget {
  expiresAt: number
  remainingBytes: number
}

export function createTerminalFileGraceBudget(now = Date.now()): TerminalFileGraceBudget {
  return {
    expiresAt: now + TERMINAL_FILE_GRACE_MS,
    remainingBytes: TERMINAL_FILE_GRACE_BYTES,
  }
}

export function consumeTerminalFileGraceBudget(
  budget: TerminalFileGraceBudget,
  frameBytes: number,
  now = Date.now(),
): boolean {
  if (
    now > budget.expiresAt ||
    !Number.isSafeInteger(frameBytes) ||
    frameBytes <= 0 ||
    frameBytes > budget.remainingBytes
  ) return false
  budget.remainingBytes -= frameBytes
  return true
}
