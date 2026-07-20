import { z } from "zod";

import {
  DEFAULT_MAX_FILE_SIZE_MB,
  MAX_MAX_FILE_SIZE_MB,
  MIN_MAX_FILE_SIZE_MB,
  PREFERENCES_STORAGE_KEY,
  PROTOCOL_VERSION,
} from "./constants.js";
import { NicknameSchema } from "./nickname.js";
import { RoomModeSchema } from "./primitives.js";

export { PREFERENCES_STORAGE_KEY };

export const LocaleSchema = z.enum(["auto", "en", "zh-CN"]);
export const ThemeSchema = z.enum(["system", "light", "dark"]);
export const SendShortcutSchema = z.enum(["enter", "mod-enter"]);
export const DensitySchema = z.enum(["comfortable", "compact"]);

export interface ClientPreferences {
  v: 1;
  locale: z.infer<typeof LocaleSchema>;
  theme: z.infer<typeof ThemeSchema>;
  defaultRoomMode: z.infer<typeof RoomModeSchema>;
  maxFileSizeMb: number;
  sendShortcut: z.infer<typeof SendShortcutSchema>;
  showTimestamps: boolean;
  density: z.infer<typeof DensitySchema>;
  rememberNickname: boolean;
  nickname?: string;
}

const ClientPreferencesObjectSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    locale: LocaleSchema,
    theme: ThemeSchema,
    defaultRoomMode: RoomModeSchema,
    maxFileSizeMb: z.number().int().min(MIN_MAX_FILE_SIZE_MB).max(MAX_MAX_FILE_SIZE_MB),
    sendShortcut: SendShortcutSchema,
    showTimestamps: z.boolean(),
    density: DensitySchema,
    rememberNickname: z.boolean(),
    nickname: NicknameSchema.optional(),
  })
  .strict();

export const ClientPreferencesSchema = ClientPreferencesObjectSchema.transform((preferences): ClientPreferences => {
  if (!preferences.rememberNickname) {
    const sanitized: ClientPreferences = { ...preferences };
    delete sanitized.nickname;
    return sanitized;
  }

  return preferences;
});

export const DEFAULT_CLIENT_PREFERENCES: ClientPreferences = Object.freeze({
  v: PROTOCOL_VERSION,
  locale: "auto",
  theme: "system",
  defaultRoomMode: "turn",
  maxFileSizeMb: DEFAULT_MAX_FILE_SIZE_MB,
  sendShortcut: "enter",
  showTimestamps: true,
  density: "comfortable",
  rememberNickname: false,
});

export function parseStoredPreferences(serialized: string | null): ClientPreferences {
  if (serialized === null) {
    return { ...DEFAULT_CLIENT_PREFERENCES };
  }

  try {
    const parsed: unknown = JSON.parse(serialized);
    const result = ClientPreferencesSchema.safeParse(parsed);
    return result.success ? result.data : { ...DEFAULT_CLIENT_PREFERENCES };
  } catch {
    return { ...DEFAULT_CLIENT_PREFERENCES };
  }
}

export function serializePreferences(preferences: unknown): string {
  return JSON.stringify(ClientPreferencesSchema.parse(preferences));
}
