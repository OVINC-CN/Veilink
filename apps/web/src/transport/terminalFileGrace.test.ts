import { describe, expect, it } from 'vitest'
import {
  createTerminalFileGraceBudget,
  consumeTerminalFileGraceBudget,
  TERMINAL_FILE_GRACE_BYTES,
  TERMINAL_FILE_GRACE_MS,
} from './terminalFileGrace'

describe('terminal file frame grace budget', () => {
  it('allows only a bounded amount of structurally valid late data', () => {
    const budget = createTerminalFileGraceBudget(1_000)

    expect(consumeTerminalFileGraceBudget(budget, TERMINAL_FILE_GRACE_BYTES - 1, 1_001)).toBe(true)
    expect(consumeTerminalFileGraceBudget(budget, 2, 1_002)).toBe(false)
    expect(budget.remainingBytes).toBe(1)
  })

  it('expires without consuming its remaining allowance', () => {
    const budget = createTerminalFileGraceBudget(5_000)

    expect(consumeTerminalFileGraceBudget(budget, 1, 5_000 + TERMINAL_FILE_GRACE_MS + 1)).toBe(false)
    expect(budget.remainingBytes).toBe(TERMINAL_FILE_GRACE_BYTES)
  })

  it('rejects invalid frame sizes', () => {
    const budget = createTerminalFileGraceBudget(10_000)

    expect(consumeTerminalFileGraceBudget(budget, 0, 10_000)).toBe(false)
    expect(consumeTerminalFileGraceBudget(budget, Number.NaN, 10_000)).toBe(false)
    expect(budget.remainingBytes).toBe(TERMINAL_FILE_GRACE_BYTES)
  })
})
