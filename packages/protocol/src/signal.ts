import { z } from "zod";

import {
  MAX_ICE_CANDIDATE_LENGTH,
  MAX_ROOM_MEMBERS,
  MAX_SIGNAL_SDP_LENGTH,
  MODE_SWITCH_TIMEOUT_MS,
  PROTOCOL_VERSION,
} from "./constants.js";
import { NicknameSchema } from "./nickname.js";
import {
  AdmissionProofSchema,
  AdmissionVerifierSchema,
  ChallengeIdSchema,
  ChallengeSchema,
  EpochMillisecondsSchema,
  IdentityPublicKeySchema,
  MemberIdSchema,
  PublicIpSchema,
  RequestIdSchema,
  ResumeTokenSchema,
  RoomEndReasonSchema,
  RoomIdSchema,
  RoomModeSchema,
} from "./primitives.js";

const ModeVersionSchema = z.number().int().positive().safe();
const SnapshotVersionSchema = z.number().int().nonnegative().safe();
const GenerationSchema = z.number().int().nonnegative().safe();

export const PublicMemberSchema = z
  .object({
    memberId: MemberIdSchema,
    nickname: NicknameSchema,
    identityPublicKey: IdentityPublicKeySchema,
    joinedAt: EpochMillisecondsSchema,
    isOwner: z.boolean(),
    publicIp: PublicIpSchema.optional(),
  })
  .strict();
export type PublicMember = z.infer<typeof PublicMemberSchema>;

export const RoomSnapshotSchema = z
  .object({
    roomId: RoomIdSchema,
    mode: RoomModeSchema,
    modeVersion: ModeVersionSchema,
    snapshotVersion: SnapshotVersionSchema,
    ownerId: MemberIdSchema,
    members: z.array(PublicMemberSchema).min(1).max(MAX_ROOM_MEMBERS),
    createdAt: EpochMillisecondsSchema,
    expiresAt: EpochMillisecondsSchema,
    serverNow: EpochMillisecondsSchema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.expiresAt <= snapshot.createdAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Room expiration must be after creation",
        path: ["expiresAt"],
      });
    }

    const owners = snapshot.members.filter((member) => member.isOwner);
    if (owners.length !== 1 || owners[0]?.memberId !== snapshot.ownerId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Room snapshot must contain exactly one matching owner",
        path: ["members"],
      });
    }

    const memberIds = new Set(snapshot.members.map((member) => member.memberId));
    if (memberIds.size !== snapshot.members.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Room snapshot contains duplicate member IDs",
        path: ["members"],
      });
    }

    for (const [index, member] of snapshot.members.entries()) {
      if (snapshot.mode === "turn" && member.publicIp !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "TURN snapshots must not expose public IP addresses",
          path: ["members", index, "publicIp"],
        });
      }
      if (snapshot.mode === "p2p" && member.publicIp === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "P2P snapshots must include every member's public IP address",
          path: ["members", index, "publicIp"],
        });
      }
    }
  });
export type RoomSnapshot = z.infer<typeof RoomSnapshotSchema>;

const EmptyPayloadSchema = z.object({}).strict();
const RTCDescriptionSchema = z
  .object({
    type: z.enum(["offer", "answer", "pranswer", "rollback"]),
    sdp: z.string().max(MAX_SIGNAL_SDP_LENGTH).optional(),
  })
  .strict()
  .refine((value) => value.type === "rollback" || (value.sdp !== undefined && value.sdp.length > 0), {
    message: "SDP is required unless the description is a rollback",
    path: ["sdp"],
  });

const RTCIceCandidateSchema = z
  .object({
    candidate: z.string().max(MAX_ICE_CANDIDATE_LENGTH),
    sdpMid: z.string().max(256).nullable(),
    sdpMLineIndex: z.number().int().min(0).max(65_535).nullable(),
    usernameFragment: z.string().max(256).nullable().optional(),
  })
  .strict();

const ClientEnvelopeBase = {
  v: z.literal(PROTOCOL_VERSION),
  requestId: RequestIdSchema.optional(),
  roomId: RoomIdSchema,
} as const;

const ServerRoomEnvelopeBase = {
  v: z.literal(PROTOCOL_VERSION),
  requestId: RequestIdSchema.optional(),
  roomId: RoomIdSchema,
} as const;

const ClientRoomCreateSchema = z
  .object({
    ...ClientEnvelopeBase,
    type: z.literal("room.create"),
    payload: z
      .object({
        nickname: NicknameSchema,
        mode: RoomModeSchema,
        admissionVerifier: AdmissionVerifierSchema,
        identityPublicKey: IdentityPublicKeySchema,
      })
      .strict(),
  })
  .strict();

const ClientRoomChallengeSchema = z
  .object({
    ...ClientEnvelopeBase,
    type: z.literal("room.challenge"),
    payload: z.object({ nickname: NicknameSchema, identityPublicKey: IdentityPublicKeySchema }).strict(),
  })
  .strict();

const ClientRoomJoinSchema = z
  .object({
    ...ClientEnvelopeBase,
    type: z.literal("room.join"),
    payload: z
      .object({
        nickname: NicknameSchema,
        identityPublicKey: IdentityPublicKeySchema,
        challengeId: ChallengeIdSchema,
        proof: AdmissionProofSchema,
      })
      .strict(),
  })
  .strict();

const ClientRoomResumeSchema = z
  .object({
    ...ClientEnvelopeBase,
    type: z.literal("room.resume"),
    payload: z
      .object({
        memberId: MemberIdSchema,
        resumeToken: ResumeTokenSchema,
        identityPublicKey: IdentityPublicKeySchema,
      })
      .strict(),
  })
  .strict();

const ClientRoomLeaveSchema = z
  .object({ ...ClientEnvelopeBase, type: z.literal("room.leave"), payload: EmptyPayloadSchema })
  .strict();
const ClientRoomDestroySchema = z
  .object({ ...ClientEnvelopeBase, type: z.literal("room.destroy"), payload: EmptyPayloadSchema })
  .strict();
const ClientModeRequestSchema = z
  .object({
    ...ClientEnvelopeBase,
    type: z.literal("room.mode.request"),
    payload: z.object({ mode: RoomModeSchema, expectedVersion: ModeVersionSchema }).strict(),
  })
  .strict();
const ClientModeAckSchema = z
  .object({
    ...ClientEnvelopeBase,
    type: z.literal("room.mode.ack"),
    payload: z
      .object({
        version: ModeVersionSchema,
        status: z.enum(["ready", "failed"]),
        reason: z.string().max(256).optional(),
      })
      .strict(),
  })
  .strict();
const ClientRtcDescriptionSchema = z
  .object({
    ...ClientEnvelopeBase,
    type: z.literal("rtc.description"),
    payload: z
      .object({
        targetMemberId: MemberIdSchema,
        modeVersion: ModeVersionSchema,
        generation: GenerationSchema,
        description: RTCDescriptionSchema,
      })
      .strict(),
  })
  .strict();
const ClientRtcCandidateSchema = z
  .object({
    ...ClientEnvelopeBase,
    type: z.literal("rtc.candidate"),
    payload: z
      .object({
        targetMemberId: MemberIdSchema,
        modeVersion: ModeVersionSchema,
        generation: GenerationSchema,
        candidate: RTCIceCandidateSchema,
      })
      .strict(),
  })
  .strict();
const ClientTurnRefreshSchema = z
  .object({
    ...ClientEnvelopeBase,
    type: z.literal("turn.credentials.refresh"),
    payload: EmptyPayloadSchema,
  })
  .strict();
const ClientHeartbeatSchema = z
  .object({
    ...ClientEnvelopeBase,
    type: z.literal("heartbeat"),
    payload: z.object({ sentAt: EpochMillisecondsSchema }).strict(),
  })
  .strict();

export const ClientSignalEnvelopeSchema = z.discriminatedUnion("type", [
  ClientRoomCreateSchema,
  ClientRoomChallengeSchema,
  ClientRoomJoinSchema,
  ClientRoomResumeSchema,
  ClientRoomLeaveSchema,
  ClientRoomDestroySchema,
  ClientModeRequestSchema,
  ClientModeAckSchema,
  ClientRtcDescriptionSchema,
  ClientRtcCandidateSchema,
  ClientTurnRefreshSchema,
  ClientHeartbeatSchema,
]);
export type ClientSignalEnvelope = z.infer<typeof ClientSignalEnvelopeSchema>;
export type ClientSignalType = ClientSignalEnvelope["type"];

const SessionConfirmationPayloadSchema = z
  .object({
    selfMemberId: MemberIdSchema,
    resumeToken: ResumeTokenSchema,
    snapshot: RoomSnapshotSchema,
  })
  .strict();

const ServerRoomCreatedSchema = z
  .object({
    ...ServerRoomEnvelopeBase,
    type: z.literal("room.created"),
    payload: SessionConfirmationPayloadSchema,
  })
  .strict();
const ServerRoomChallengeSchema = z
  .object({
    ...ServerRoomEnvelopeBase,
    type: z.literal("room.challenge"),
    payload: z
      .object({
        challengeId: ChallengeIdSchema,
        challenge: ChallengeSchema,
        mode: RoomModeSchema,
        expiresAt: EpochMillisecondsSchema,
      })
      .strict(),
  })
  .strict();
const ServerRoomJoinedSchema = z
  .object({
    ...ServerRoomEnvelopeBase,
    type: z.literal("room.joined"),
    payload: SessionConfirmationPayloadSchema,
  })
  .strict();
const ServerRoomResumedSchema = z
  .object({
    ...ServerRoomEnvelopeBase,
    type: z.literal("room.resumed"),
    payload: SessionConfirmationPayloadSchema,
  })
  .strict();
const ServerRoomSnapshotSchema = z
  .object({
    ...ServerRoomEnvelopeBase,
    type: z.literal("room.snapshot"),
    payload: RoomSnapshotSchema,
  })
  .strict();
const ServerMemberJoinedSchema = z
  .object({
    ...ServerRoomEnvelopeBase,
    type: z.literal("room.member.joined"),
    payload: z.object({ member: PublicMemberSchema, snapshotVersion: SnapshotVersionSchema }).strict(),
  })
  .strict();
const ServerMemberLeftSchema = z
  .object({
    ...ServerRoomEnvelopeBase,
    type: z.literal("room.member.left"),
    payload: z
      .object({
        memberId: MemberIdSchema,
        reason: z.enum(["left", "timeout", "disconnected", "mode-switch-failed"]),
        snapshotVersion: SnapshotVersionSchema,
      })
      .strict(),
  })
  .strict();
const ServerOwnerChangedSchema = z
  .object({
    ...ServerRoomEnvelopeBase,
    type: z.literal("room.owner.changed"),
    payload: z.object({ ownerId: MemberIdSchema, snapshotVersion: SnapshotVersionSchema }).strict(),
  })
  .strict();
const ServerModePendingSchema = z
  .object({
    ...ServerRoomEnvelopeBase,
    type: z.literal("room.mode.pending"),
    payload: z
      .object({
        previousMode: RoomModeSchema,
        mode: RoomModeSchema,
        version: ModeVersionSchema,
        requestedBy: MemberIdSchema,
        deadlineAt: EpochMillisecondsSchema,
      })
      .strict()
      .refine((value) => value.mode !== value.previousMode, "Mode switch must change mode"),
  })
  .strict();
const ServerModeChangedSchema = z
  .object({
    ...ServerRoomEnvelopeBase,
    type: z.literal("room.mode.changed"),
    payload: z.object({ mode: RoomModeSchema, version: ModeVersionSchema }).strict(),
  })
  .strict();
const ServerRtcDescriptionSchema = z
  .object({
    ...ServerRoomEnvelopeBase,
    type: z.literal("rtc.description"),
    payload: z
      .object({
        fromMemberId: MemberIdSchema,
        modeVersion: ModeVersionSchema,
        generation: GenerationSchema,
        description: RTCDescriptionSchema,
      })
      .strict(),
  })
  .strict();
const ServerRtcCandidateSchema = z
  .object({
    ...ServerRoomEnvelopeBase,
    type: z.literal("rtc.candidate"),
    payload: z
      .object({
        fromMemberId: MemberIdSchema,
        modeVersion: ModeVersionSchema,
        generation: GenerationSchema,
        candidate: RTCIceCandidateSchema,
      })
      .strict(),
  })
  .strict();

const TurnUrlSchema = z
  .string()
  .max(2_048)
  .refine((value) => value.startsWith("turn:") || value.startsWith("turns:"), "Invalid TURN URL");
export const TurnCredentialsSchema = z
  .object({
    urls: z.array(TurnUrlSchema).min(1).max(8),
    username: z.string().min(1).max(256),
    credential: z.string().min(1).max(512),
    credentialType: z.literal("password"),
    expiresAt: EpochMillisecondsSchema,
  })
  .strict();
export type TurnCredentials = z.infer<typeof TurnCredentialsSchema>;

const ServerTurnCredentialsSchema = z
  .object({
    ...ServerRoomEnvelopeBase,
    type: z.literal("turn.credentials"),
    payload: TurnCredentialsSchema,
  })
  .strict();
const ServerHeartbeatAckSchema = z
  .object({
    ...ServerRoomEnvelopeBase,
    type: z.literal("heartbeat.ack"),
    payload: z.object({ sentAt: EpochMillisecondsSchema, serverNow: EpochMillisecondsSchema }).strict(),
  })
  .strict();
const ServerRoomEndedSchema = z
  .object({
    ...ServerRoomEnvelopeBase,
    type: z.literal("room.ended"),
    payload: z.object({ reason: RoomEndReasonSchema }).strict(),
  })
  .strict();

export const SignalErrorCodeSchema = z.enum([
  "invalid_request",
  "unsupported_version",
  "room_not_found",
  "room_exists",
  "room_full",
  "room_expired",
  "challenge_expired",
  "bad_proof",
  "rate_limited",
  "resume_rejected",
  "forbidden",
  "mode_conflict",
  "mode_timeout",
  "member_not_found",
  "invalid_signal",
  "internal_error",
]);
export type SignalErrorCode = z.infer<typeof SignalErrorCodeSchema>;

const ServerErrorSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    type: z.literal("error"),
    requestId: RequestIdSchema.optional(),
    roomId: RoomIdSchema.optional(),
    payload: z
      .object({
        code: SignalErrorCodeSchema,
        message: z.string().min(1).max(256),
        retryAfterMs: z.number().int().positive().max(24 * 60 * 60 * 1_000).optional(),
      })
      .strict(),
  })
  .strict();

export const ServerSignalEnvelopeSchema = z.discriminatedUnion("type", [
  ServerRoomCreatedSchema,
  ServerRoomChallengeSchema,
  ServerRoomJoinedSchema,
  ServerRoomResumedSchema,
  ServerRoomSnapshotSchema,
  ServerMemberJoinedSchema,
  ServerMemberLeftSchema,
  ServerOwnerChangedSchema,
  ServerModePendingSchema,
  ServerModeChangedSchema,
  ServerRtcDescriptionSchema,
  ServerRtcCandidateSchema,
  ServerTurnCredentialsSchema,
  ServerHeartbeatAckSchema,
  ServerRoomEndedSchema,
  ServerErrorSchema,
]);
export type ServerSignalEnvelope = z.infer<typeof ServerSignalEnvelopeSchema>;
export type ServerSignalType = ServerSignalEnvelope["type"];

export function parseClientSignalEnvelope(input: unknown): ClientSignalEnvelope {
  return ClientSignalEnvelopeSchema.parse(input);
}

export function parseServerSignalEnvelope(input: unknown): ServerSignalEnvelope {
  return ServerSignalEnvelopeSchema.parse(input);
}

export const SIGNAL_LIMITS = {
  maxSdpLength: MAX_SIGNAL_SDP_LENGTH,
  maxIceCandidateLength: MAX_ICE_CANDIDATE_LENGTH,
  modeSwitchTimeoutMs: MODE_SWITCH_TIMEOUT_MS,
} as const;
