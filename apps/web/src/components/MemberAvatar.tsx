interface MemberAvatarProps {
  seed: string
  label?: string
  className?: string
}

function seedHash(seed: string): number {
  let hash = 0x811c9dc5
  for (const character of seed) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function nextRandom(state: number): number {
  let value = state + 0x6d2b79f5
  value = Math.imul(value ^ (value >>> 15), value | 1)
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
  return (value ^ (value >>> 14)) >>> 0
}

export function MemberAvatar({ seed, label, className = '' }: MemberAvatarProps) {
  let state = seedHash(seed)
  const hue = state % 360
  const cells: Array<{ x: number; y: number }> = []

  for (let y = 0; y < 5; y += 1) {
    for (let x = 0; x < 3; x += 1) {
      state = nextRandom(state)
      if ((state & 3) === 0) continue
      cells.push({ x, y })
      if (x !== 2) cells.push({ x: 4 - x, y })
    }
  }

  if (cells.length === 0) cells.push({ x: 2, y: 2 })

  return (
    <svg
      className={`member-avatar ${className}`.trim()}
      viewBox="0 0 5 5"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <rect width="5" height="5" fill="var(--surface-soft)" />
      {cells.map((cell) => (
        <rect key={`${cell.x}-${cell.y}`} x={cell.x} y={cell.y} width="1" height="1" fill={`hsl(${hue} 62% 45%)`} />
      ))}
    </svg>
  )
}
