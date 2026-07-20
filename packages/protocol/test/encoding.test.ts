import { describe, expect, it } from "vitest";

import {
  LINK_SECRET_BYTES,
  ROOM_ID_BYTES,
  base64UrlDecode,
  base64UrlEncode,
  buildInvitePath,
  encodeHkdfInfo,
  generateLinkSecret,
  generatePin,
  generateRoomId,
  timingSafeEqual,
} from "../src/index.js";

describe("base64url helpers", () => {
  it("round-trips bytes canonically without padding", () => {
    const bytes = Uint8Array.from([0, 1, 2, 253, 254, 255]);
    const encoded = base64UrlEncode(bytes);

    expect(encoded).toBe("AAEC_f7_");
    expect(base64UrlDecode(encoded)).toEqual(bytes);
  });

  it.each(["a", "AA==", "AA+", "AA/", "not valid"])("rejects malformed value %s", (value) => {
    expect(() => base64UrlDecode(value)).toThrow(TypeError);
  });

  it("compares byte arrays without early value exits", () => {
    expect(timingSafeEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).toBe(true);
    expect(timingSafeEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 3))).toBe(false);
    expect(timingSafeEqual(Uint8Array.of(1), Uint8Array.of(1, 0))).toBe(false);
  });
});

describe("room identifiers", () => {
  it("generates correctly sized room secrets and a fragment-only invite secret", () => {
    const roomId = generateRoomId();
    const linkSecret = generateLinkSecret();

    expect(base64UrlDecode(roomId)).toHaveLength(ROOM_ID_BYTES);
    expect(base64UrlDecode(linkSecret)).toHaveLength(LINK_SECRET_BYTES);
    expect(buildInvitePath(roomId, linkSecret)).toBe(`/room/${roomId}#${linkSecret}`);
  });

  it("generates six decimal digits including zero padding", () => {
    for (let index = 0; index < 100; index += 1) {
      expect(generatePin()).toMatch(/^\d{6}$/u);
    }
  });

  it("domain-separates HKDF info", () => {
    const roomId = generateRoomId();
    const messageInfo = encodeHkdfInfo("message", roomId);
    const fileInfo = encodeHkdfInfo("file", roomId);

    expect(messageInfo).not.toEqual(fileInfo);
    expect(new TextDecoder().decode(messageInfo)).toContain(roomId);
  });
});
