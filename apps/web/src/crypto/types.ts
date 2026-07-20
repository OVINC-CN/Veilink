export interface DerivedKeys {
  admissionKey: Uint8Array
  messageKey: Uint8Array
  fileKey: Uint8Array
  fingerprintKey: Uint8Array
  fingerprint: string
}

export interface SessionIdentity {
  publicKey: Uint8Array
  privateKey: Uint8Array
  sessionId: string
  counter: number
}
