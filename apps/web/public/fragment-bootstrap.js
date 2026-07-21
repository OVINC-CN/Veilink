(() => {
  try {
    const stored = JSON.parse(localStorage.getItem('veilink.preferences.v1') || '{}')
    const theme = stored?.theme
    document.documentElement.dataset.theme = theme === 'light' || theme === 'dark' ? theme : 'system'
  } catch {
    document.documentElement.dataset.theme = 'system'
  }

  const bootstrapHistoryKey = '__veilinkBootstrapInvite'
  const roomMatch = /^\/room\/([A-Za-z0-9_-]{22})\/?$/.exec(window.location.pathname)
  const roomId = roomMatch?.[1]
  const candidate = window.location.hash.slice(1)
  const state = window.history.state && typeof window.history.state === 'object' && !Array.isArray(window.history.state)
    ? { ...window.history.state }
    : {}
  const fallback = state[bootstrapHistoryKey]
  const fallbackSecret = fallback
    && typeof fallback === 'object'
    && fallback.roomId === roomId
    && /^[A-Za-z0-9_-]{43}$/.test(fallback.linkSecret)
    ? fallback.linkSecret
    : undefined
  const secret = roomId && /^[A-Za-z0-9_-]{43}$/.test(candidate) ? candidate : fallbackSecret

  if (secret) {
    Object.defineProperty(window, '__VEILINK_BOOTSTRAP_SECRET__', {
      configurable: true,
      enumerable: false,
      value: secret,
      writable: true,
    })
  }

  if (roomId && /^[A-Za-z0-9_-]{43}$/.test(candidate)) {
    state[bootstrapHistoryKey] = { roomId, linkSecret: candidate }
  } else if (!roomId) {
    delete state[bootstrapHistoryKey]
  }

  if (window.location.hash) {
    window.history.replaceState(
      state,
      '',
      `${window.location.pathname}${window.location.search}`,
    )
  }
})()
