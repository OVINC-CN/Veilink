import { toSvg } from 'jdenticon'
import { useMemo } from 'react'

interface MemberAvatarProps {
  seed: string
  label?: string
  className?: string
}

export function MemberAvatar({ seed, label, className = '' }: MemberAvatarProps) {
  const source = useMemo(() => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(toSvg(seed, 96, {
    backColor: '#f4f6f8ff',
    saturation: { color: 0.62, grayscale: 0.12 },
    lightness: { color: [0.34, 0.68], grayscale: [0.30, 0.74] },
    padding: 0.12,
  }))}`, [seed])
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
