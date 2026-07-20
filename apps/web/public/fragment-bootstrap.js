(() => {
  const candidate = window.location.hash.slice(1)
  if (/^[A-Za-z0-9_-]{43}$/.test(candidate)) {
    Object.defineProperty(window, '__VEILINK_BOOTSTRAP_SECRET__', {
      configurable: true,
      enumerable: false,
      value: candidate,
      writable: true,
    })
  }

  if (window.location.hash) {
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${window.location.search}`,
    )
  }
})()
