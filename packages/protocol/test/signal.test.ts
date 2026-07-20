import { describe, expect, it } from "vitest";

import {
  AdmissionVerifierSchema,
  ClientSignalEnvelopeSchema,
  IdentityPublicKeySchema,
  MemberIdSchema,
  RequestIdSchema,
  RoomIdSchema,
  RoomSnapshotSchema,
  ServerSignalEnvelopeSchema,
  base64UrlEncode,
} from "../src/index.js";

function fixedToken(bytes: number, fill: number): string {
  return base64UrlEncode(new Uint8Array(bytes).fill(fill));
}

const roomId = RoomIdSchema.parse(fixedToken(16, 1));
const memberId = MemberIdSchema.parse(fixedToken(16, 2));
const publicKey = IdentityPublicKeySchema.parse(fixedToken(32, 3));
const admissionVerifier = AdmissionVerifierSchema.parse(fixedToken(32, 4));
const requestId = RequestIdSchema.parse("request_123");

const p2pSnapshot = {
  roomId,
  mode: "p2p" as const,
  modeVersion: 1,
  snapshotVersion: 1,
  ownerId: memberId,
  members: [
    {
      memberId,
      nickname: "Owner",
      identityPublicKey: publicKey,
      joinedAt: 1_000,
      isOwner: true,
      publicIp: "203.0.113.8",
    },
  ],
  createdAt: 1_000,
  expiresAt: 2_000,
  serverNow: 1_100,
};

describe("room snapshot invariants", () => {
  it("accepts P2P snapshots containing the server-observed IP", () => {
    expect(RoomSnapshotSchema.safeParse(p2pSnapshot).success).toBe(true);
  });

  it("prevents public IP disclosure in TURN snapshots", () => {
    expect(RoomSnapshotSchema.safeParse({ ...p2pSnapshot, mode: "turn" }).success).toBe(false);
  });

  it("requires exactly one matching owner", () => {
    const invalid = {
      ...p2pSnapshot,
      members: [{ ...p2pSnapshot.members[0], isOwner: false }],
    };
    expect(RoomSnapshotSchema.safeParse(invalid).success).toBe(false);
  });
});

describe("versioned signaling envelopes", () => {
  it("strictly parses a room creation request", () => {
    const message = {
      v: 1,
      type: "room.create",
      requestId,
      roomId,
      payload: {
        nickname: "  Owner  ",
        mode: "turn",
        admissionVerifier,
        identityPublicKey: publicKey,
      },
    };

    const parsed = ClientSignalEnvelopeSchema.parse(message);
    expect(parsed.type).toBe("room.create");
    if (parsed.type === "room.create") {
      expect(parsed.payload.nickname).toBe("Owner");
    }
  });

  it("rejects unknown fields and unsupported protocol versions", () => {
    const message = {
      v: 2,
      type: "room.create",
      requestId,
      roomId,
      payload: {
        nickname: "Owner",
        mode: "turn",
        admissionVerifier,
        identityPublicKey: publicKey,
        secret: "unexpected",
      },
    };

    expect(ClientSignalEnvelopeSchema.safeParse(message).success).toBe(false);
  });

  it("accepts a bounded server error without requiring a room ID", () => {
    const error = {
      v: 1,
      type: "error",
      requestId,
      payload: { code: "rate_limited", message: "Try again later", retryAfterMs: 1_000 },
    };
    expect(ServerSignalEnvelopeSchema.safeParse(error).success).toBe(true);
  });

  it("rejects SDP beyond the signaling limit", () => {
    const message = {
      v: 1,
      type: "rtc.description",
      roomId,
      payload: {
        targetMemberId: memberId,
        modeVersion: 1,
        generation: 0,
        description: { type: "offer", sdp: "x".repeat(128 * 1024 + 1) },
      },
    };
    expect(ClientSignalEnvelopeSchema.safeParse(message).success).toBe(false);
  });
});
