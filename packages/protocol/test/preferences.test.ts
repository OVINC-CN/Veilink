import { describe, expect, it } from "vitest";

import {
  DEFAULT_CLIENT_PREFERENCES,
  PREFERENCES_STORAGE_KEY,
  ClientPreferencesSchema,
  NicknameSchema,
  normalizeFileName,
  normalizeNickname,
  parseStoredPreferences,
  serializePreferences,
} from "../src/index.js";

describe("display names", () => {
  it("normalizes nicknames to NFC and trims spacing", () => {
    expect(normalizeNickname("  Cafe\u0301   Team  ")).toBe("Café Team");
    expect(NicknameSchema.parse("隐私用户")).toBe("隐私用户");
  });

  it.each(["hello\nworld", "owner\u202eadmin", "\u0000name"])(
    "rejects control or bidi value %j",
    (value) => {
      expect(() => normalizeNickname(value)).toThrow();
    },
  );

  it("rejects path-like file names", () => {
    expect(() => normalizeFileName("../../secret.txt")).toThrow();
    expect(normalizeFileName("  photo.png ")).toBe("photo.png");
  });
});

describe("privacy-preserving preferences", () => {
  const base = {
    v: 1 as const,
    locale: "zh-CN" as const,
    theme: "system" as const,
    defaultRoomMode: "turn" as const,
    maxFileSizeMb: 25,
    sendShortcut: "enter" as const,
    showTimestamps: true,
    density: "comfortable" as const,
    rememberNickname: false,
  };

  it("uses the versioned, single storage key", () => {
    expect(PREFERENCES_STORAGE_KEY).toBe("veilink.preferences.v1");
  });

  it("removes nickname when remembering is disabled", () => {
    const parsed = ClientPreferencesSchema.parse({ ...base, nickname: "Alice" });
    expect(parsed).not.toHaveProperty("nickname");
    expect(serializePreferences({ ...base, nickname: "Alice" })).not.toContain("Alice");
  });

  it("keeps a normalized nickname only after opt-in", () => {
    const parsed = ClientPreferencesSchema.parse({ ...base, rememberNickname: true, nickname: " Café  " });
    expect(parsed.nickname).toBe("Café");
  });

  it("rejects unknown or sensitive keys and falls back atomically", () => {
    const stored = JSON.stringify({ ...base, roomId: "must-not-persist" });
    expect(parseStoredPreferences(stored)).toEqual(DEFAULT_CLIENT_PREFERENCES);
    expect(parseStoredPreferences("not-json")).toEqual(DEFAULT_CLIENT_PREFERENCES);
  });
});
