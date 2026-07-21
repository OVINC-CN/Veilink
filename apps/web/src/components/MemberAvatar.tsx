import avatarCyan from '../assets/avatars/avatar-cyan.png'
import avatarIndigo from '../assets/avatars/avatar-indigo.png'
import avatarSlate from '../assets/avatars/avatar-slate.png'

interface MemberAvatarProps {
  seed: string
  label?: string
  className?: string
}

const avatars = [avatarCyan, avatarIndigo, avatarSlate] as const

function seedHash(seed: string): number {
  let hash = 0x811c9dc5
  for (const character of seed) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

export function MemberAvatar({ seed, label, className = '' }: MemberAvatarProps) {
  const source = avatars[seedHash(seed) % avatars.length] ?? avatarCyan
  return (
    <img
      className={`member-avatar ${className}`.trim()}
      src={source}
      alt={label ?? ''}
      aria-hidden={label ? undefined : true}
      draggable={false}
    />
  )
}
