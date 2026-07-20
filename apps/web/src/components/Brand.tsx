import logoUrl from '../../../../assets/veilink-logo.png'

export function Brand() {
  return (
    <div className="brand-block">
      <img className="brand-logo" src={logoUrl} alt="Veilink" />
    </div>
  )
}
