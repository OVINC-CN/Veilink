import { z } from "zod";

import {
  ADMISSION_VERIFIER_BYTES,
  CHALLENGE_BYTES,
  DIGEST_BYTES,
  ED25519_SIGNATURE_BYTES,
  IDENTITY_PUBLIC_KEY_BYTES,
  LINK_SECRET_BYTES,
  MEMBER_ID_BYTES,
  RESUME_TOKEN_BYTES,
  ROOM_ID_BYTES,
  SECRETSTREAM_HEADER_BYTES,
  XCHACHA20_NONCE_BYTES,
} from "./constants.js";
import { base64UrlDecode } from "./encoding.js";

const exactBase64UrlBytes = (byteLength: number, label: string) =>
  z.string().refine(
    (value) => {
      try {
        return base64UrlDecode(value).byteLength === byteLength;
      } catch {
        return false;
      }
    },
    { message: `${label} must be canonical base64url encoding of ${byteLength} bytes` },
  );

export const RoomModeSchema = z.enum(["p2p", "turn"]);
export type RoomMode = z.infer<typeof RoomModeSchema>;

export const RoomEndReasonSchema = z.enum([
  "last-member-left",
  "expired",
  "destroyed-by-owner",
  "server-restarted",
]);
export type RoomEndReason = z.infer<typeof RoomEndReasonSchema>;

export const RoomIdSchema = exactBase64UrlBytes(ROOM_ID_BYTES, "Room ID").brand("RoomId");
export type RoomId = z.infer<typeof RoomIdSchema>;

export const LinkSecretSchema = exactBase64UrlBytes(LINK_SECRET_BYTES, "Link secret").brand(
  "LinkSecret",
);
export type LinkSecret = z.infer<typeof LinkSecretSchema>;

export const MemberIdSchema = exactBase64UrlBytes(MEMBER_ID_BYTES, "Member ID").brand("MemberId");
export type MemberId = z.infer<typeof MemberIdSchema>;

export const ResumeTokenSchema = exactBase64UrlBytes(RESUME_TOKEN_BYTES, "Resume token").brand(
  "ResumeToken",
);
export type ResumeToken = z.infer<typeof ResumeTokenSchema>;

export const ChallengeIdSchema = exactBase64UrlBytes(ROOM_ID_BYTES, "Challenge ID").brand(
  "ChallengeId",
);
export type ChallengeId = z.infer<typeof ChallengeIdSchema>;

export const ChallengeSchema = exactBase64UrlBytes(CHALLENGE_BYTES, "Challenge").brand("Challenge");
export type Challenge = z.infer<typeof ChallengeSchema>;

export const AdmissionVerifierSchema = exactBase64UrlBytes(
  ADMISSION_VERIFIER_BYTES,
  "Admission verifier",
).brand("AdmissionVerifier");
export type AdmissionVerifier = z.infer<typeof AdmissionVerifierSchema>;

export const AdmissionProofSchema = exactBase64UrlBytes(
  ADMISSION_VERIFIER_BYTES,
  "Admission proof",
).brand("AdmissionProof");
export type AdmissionProof = z.infer<typeof AdmissionProofSchema>;

export const IdentityPublicKeySchema = exactBase64UrlBytes(
  IDENTITY_PUBLIC_KEY_BYTES,
  "Identity public key",
).brand("IdentityPublicKey");
export type IdentityPublicKey = z.infer<typeof IdentityPublicKeySchema>;

export const SignatureSchema = exactBase64UrlBytes(ED25519_SIGNATURE_BYTES, "Signature").brand(
  "Signature",
);
export type Signature = z.infer<typeof SignatureSchema>;

export const NonceSchema = exactBase64UrlBytes(XCHACHA20_NONCE_BYTES, "Nonce").brand("Nonce");
export type Nonce = z.infer<typeof NonceSchema>;

export const SecretstreamHeaderSchema = exactBase64UrlBytes(
  SECRETSTREAM_HEADER_BYTES,
  "Secretstream header",
).brand("SecretstreamHeader");
export type SecretstreamHeader = z.infer<typeof SecretstreamHeaderSchema>;

export const DigestSchema = exactBase64UrlBytes(DIGEST_BYTES, "Digest").brand("Digest");
export type Digest = z.infer<typeof DigestSchema>;

export const AttachmentIdSchema = exactBase64UrlBytes(MEMBER_ID_BYTES, "Attachment ID").brand(
  "AttachmentId",
);
export type AttachmentId = z.infer<typeof AttachmentIdSchema>;

export const MessageIdSchema = exactBase64UrlBytes(MEMBER_ID_BYTES, "Message ID").brand("MessageId");
export type MessageId = z.infer<typeof MessageIdSchema>;

export const SessionIdSchema = exactBase64UrlBytes(MEMBER_ID_BYTES, "Session ID").brand("SessionId");
export type SessionId = z.infer<typeof SessionIdSchema>;

export const RequestIdSchema = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/u, "Request ID must be an opaque base64url-style token");
export type RequestId = z.infer<typeof RequestIdSchema>;

export const EpochMillisecondsSchema = z.number().int().nonnegative().safe();

export const PublicIpSchema = z.string().ip();

export const PinSchema = z.string().regex(/^\d{6}$/u, "PIN must contain exactly six digits");
export type Pin = z.infer<typeof PinSchema>;
