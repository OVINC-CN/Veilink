import logoUrl from '../../../../assets/veilink-logo.png'

export function Brand({ tagline }: { tagline: string }) {
  return (
    <div className="brand-block">
      <img className="brand-logo" src={logoUrl} alt="Veilink" />
      <span>{tagline}</span>
    </div>
  )
}
