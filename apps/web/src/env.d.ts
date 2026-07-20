/// <reference types="vite/client" />

declare global {
  interface Window {
    __VEILINK_BOOTSTRAP_SECRET__?: string
  }
}

export {}
