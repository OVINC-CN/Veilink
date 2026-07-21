import {
  LINK_SECRET_BYTES,
  MEMBER_ID_BYTES,
  PIN_LENGTH,
  RESUME_TOKEN_BYTES,
  ROOM_ID_BYTES,
} from "./constants.js";
import { generateBase64UrlToken, randomBytes } from "./encoding.js";
import {
  LinkSecretSchema,
  MemberIdSchema,
  PinSchema,
  ResumeTokenSchema,
  RoomIdSchema,
  type LinkSecret,
  type MemberId,
  type Pin,
  type ResumeToken,
  type RoomId,
} from "./primitives.js";

const PIN_RANGE = 10 ** PIN_LENGTH;
const UINT32_RANGE = 0x1_0000_0000;
const MAX_UNBIASED_PIN_VALUE = Math.floor(UINT32_RANGE / PIN_RANGE) * PIN_RANGE;

export function generateRoomId(): RoomId {
  return RoomIdSchema.parse(generateBase64UrlToken(ROOM_ID_BYTES));
}

export function generateLinkSecret(): LinkSecret {
  return LinkSecretSchema.parse(generateBase64UrlToken(LINK_SECRET_BYTES));
}

export function generateMemberId(): MemberId {
  return MemberIdSchema.parse(generateBase64UrlToken(MEMBER_ID_BYTES));
}

export function generateResumeToken(): ResumeToken {
  return ResumeTokenSchema.parse(generateBase64UrlToken(RESUME_TOKEN_BYTES));
}

export function generateRequestId(): string {
  return generateBase64UrlToken(12);
}

export function generatePin(): Pin {
  let value: number;

  do {
    const bytes = randomBytes(4);
    value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
  } while (value >= MAX_UNBIASED_PIN_VALUE);

  return PinSchema.parse(String(value % PIN_RANGE).padStart(PIN_LENGTH, "0"));
}

export function buildInvitePath(roomId: RoomId, linkSecret: LinkSecret): string {
  return `/room/${RoomIdSchema.parse(roomId)}#${LinkSecretSchema.parse(linkSecret)}`;
}
