// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  AdmissionVerifierSchema,
  ClientSignalEnvelopeSchema,
  IdentityPublicKeySchema,
  MemberIdSchema,
  PROTOCOL_VERSION,
  RequestIdSchema,
  RoomIdSchema,
  RoomSnapshotSchema,
  ServerSignalEnvelopeSchema,
  base64UrlEncode,
} from "./index.js";

function fixedToken(bytes: number, fill: number): string {
  return base64UrlEncode(new Uint8Array(bytes).fill(fill));
}

const roomId = RoomIdSchema.parse(fixedToken(16, 1));
const memberId = MemberIdSchema.parse(fixedToken(16, 2));
const publicKey = IdentityPublicKeySchema.parse(fixedToken(32, 3));
const admissionVerifier = AdmissionVerifierSchema.parse(fixedToken(32, 4));
const requestId = RequestIdSchema.parse("request_123");

const snapshot = {
  roomId,
  snapshotVersion: 1,
  ownerId: memberId,
  members: [
    {
      memberId,
      nickname: "Owner",
      identityPublicKey: publicKey,
      joinedAt: 1_000,
      isOwner: true,
    },
  ],
  createdAt: 1_000,
  expiresAt: 2_000,
  serverNow: 1_100,
};

describe("room snapshot invariants", () => {
  it("accepts TURN-only snapshots without member IP addresses", () => {
    expect(RoomSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it("rejects snapshots that disclose a member IP address", () => {
    const disclosed = {
      ...snapshot,
      members: [{ ...snapshot.members[0], publicIp: "203.0.113.8" }],
    };
    expect(RoomSnapshotSchema.safeParse(disclosed).success).toBe(false);
  });

  it("requires exactly one matching owner", () => {
    const invalid = {
      ...snapshot,
      members: [{ ...snapshot.members[0], isOwner: false }],
    };
    expect(RoomSnapshotSchema.safeParse(invalid).success).toBe(false);
  });
});

describe("versioned signaling envelopes", () => {
  it("strictly parses a room creation request", () => {
    const message = {
      v: PROTOCOL_VERSION,
      type: "room.create",
      requestId,
      roomId,
      payload: {
        nickname: "  Owner  ",
        admissionVerifier,
        identityPublicKey: publicKey,
        creationPassword: "shared deployment secret",
      },
    };

    const parsed = ClientSignalEnvelopeSchema.parse(message);
    expect(parsed.type).toBe("room.create");
    if (parsed.type === "room.create") {
      expect(parsed.payload.nickname).toBe("Owner");
      expect(parsed.payload.creationPassword).toBe("shared deployment secret");
    }
  });

  it("accepts an omitted creation password and rejects an oversized one", () => {
    const base = {
      v: PROTOCOL_VERSION,
      type: "room.create",
      requestId,
      roomId,
      payload: { nickname: "Owner", admissionVerifier, identityPublicKey: publicKey },
    };
    expect(ClientSignalEnvelopeSchema.safeParse(base).success).toBe(true);
    expect(ClientSignalEnvelopeSchema.safeParse({
      ...base,
      payload: { ...base.payload, creationPassword: "x".repeat(257) },
    }).success).toBe(false);
  });

  it("parses relay credential requests and responses", () => {
    expect(ClientSignalEnvelopeSchema.safeParse({
      v: PROTOCOL_VERSION,
      type: "turn.credentials.refresh",
      requestId,
      roomId,
      payload: {},
    }).success).toBe(true);
    expect(ServerSignalEnvelopeSchema.safeParse({
      v: PROTOCOL_VERSION,
      type: "turn.credentials",
      requestId,
      roomId,
      payload: {
        iceServers: [{
          urls: ["turns:turn.cloudflare.com:443?transport=tcp"],
          username: "temporary-user",
          credential: "temporary-credential",
          credentialType: "password",
        }],
        expiresAt: 90_000_000,
      },
    }).success).toBe(true);
  });

  it("rejects legacy P2P creation and mode-switch requests", () => {
    const p2pCreation = {
      v: PROTOCOL_VERSION,
      type: "room.create",
      roomId,
      payload: {
        nickname: "Owner",
        mode: "p2p",
        admissionVerifier,
        identityPublicKey: publicKey,
      },
    };
    const modeSwitch = {
      v: PROTOCOL_VERSION,
      type: "room.mode.request",
      roomId,
      payload: { mode: "p2p", expectedVersion: 1 },
    };

    expect(ClientSignalEnvelopeSchema.safeParse(p2pCreation).success).toBe(false);
    expect(ClientSignalEnvelopeSchema.safeParse(modeSwitch).success).toBe(false);
  });

  it("rejects unknown fields and unsupported protocol versions", () => {
    const message = {
      v: 1,
      type: "room.create",
      requestId,
      roomId,
      payload: {
        nickname: "Owner",
        admissionVerifier,
        identityPublicKey: publicKey,
        secret: "unexpected",
      },
    };

    expect(ClientSignalEnvelopeSchema.safeParse(message).success).toBe(false);
  });

  it("accepts a bounded server error without requiring a room ID", () => {
    const error = {
      v: PROTOCOL_VERSION,
      type: "error",
      requestId,
      payload: { code: "rate_limited", message: "Try again later", retryAfterMs: 1_000 },
    };
    expect(ServerSignalEnvelopeSchema.safeParse(error).success).toBe(true);
  });

  it("rejects SDP beyond the signaling limit", () => {
    const message = {
      v: PROTOCOL_VERSION,
      type: "rtc.description",
      roomId,
      payload: {
        targetMemberId: memberId,
        description: { type: "offer", sdp: "x".repeat(128 * 1024 + 1) },
      },
    };
    expect(ClientSignalEnvelopeSchema.safeParse(message).success).toBe(false);
  });
});
