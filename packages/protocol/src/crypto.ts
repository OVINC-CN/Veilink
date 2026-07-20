import { PROTOCOL_VERSION } from "./constants.js";
import {
  ChallengeIdSchema,
  ChallengeSchema,
  RoomIdSchema,
  type Challenge,
  type ChallengeId,
  type RoomId,
} from "./primitives.js";

export const HKDF_DOMAIN_LABELS = {
  admission: "veilink/v1/admission",
  message: "veilink/v1/message",
  file: "veilink/v1/file",
  fingerprint: "veilink/v1/fingerprint",
} as const;

export type HkdfDomain = keyof typeof HKDF_DOMAIN_LABELS;

export const CRYPTO_SUITE = {
  id: "veilink-v1",
  protocolVersion: PROTOCOL_VERSION,
  pinKdf: {
    algorithm: "Argon2id",
    version: 0x13,
    memoryKiB: 65_536,
    operations: 3,
    outputBytes: 32,
  },
  keyDerivation: {
    algorithm: "HKDF-SHA-256",
    outputBytes: 32,
  },
  messageEncryption: {
    algorithm: "XChaCha20-Poly1305-IETF",
    nonceBytes: 24,
  },
  fileEncryption: {
    algorithm: "XChaCha20-Poly1305-secretstream",
    chunkBytes: 65_536,
    headerBytes: 24,
  },
  identity: {
    algorithm: "Ed25519",
    publicKeyBytes: 32,
    signatureBytes: 64,
  },
  digest: {
    algorithm: "BLAKE2b-256",
    outputBytes: 32,
  },
} as const;

const encoder = new TextEncoder();

export function encodeHkdfInfo(domain: HkdfDomain, roomId: RoomId): Uint8Array {
  const validatedRoomId = RoomIdSchema.parse(roomId);
  return encoder.encode(`${HKDF_DOMAIN_LABELS[domain]}\0${validatedRoomId}`);
}

export function encodeAdmissionChallenge(
  roomId: RoomId,
  challengeId: ChallengeId,
  challenge: Challenge,
): Uint8Array {
  const validatedRoomId = RoomIdSchema.parse(roomId);
  const validatedChallengeId = ChallengeIdSchema.parse(challengeId);
  const validatedChallenge = ChallengeSchema.parse(challenge);
  return encoder.encode(
    `veilink/v1/admission-proof\0${validatedRoomId}\0${validatedChallengeId}\0${validatedChallenge}`,
  );
}
