import { z } from "zod";

import {
  MAX_FILE_NAME_BYTES,
  MAX_NICKNAME_BYTES,
  MAX_NICKNAME_GRAPHEMES,
} from "./constants.js";

const encoder = new TextEncoder();
const FORBIDDEN_CONTROLS = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u;
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const PATH_SEPARATORS = /[\\/]/u;

export class DisplayNameValidationError extends TypeError {
  public constructor(message: string) {
    super(message);
    this.name = "DisplayNameValidationError";
  }
}

function countGraphemes(value: string): number {
  if (typeof Intl.Segmenter === "function") {
    return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].length;
  }

  return [...value].length;
}

function normalizeDisplayText(value: string): string {
  if (FORBIDDEN_CONTROLS.test(value) || BIDI_CONTROLS.test(value)) {
    throw new DisplayNameValidationError("Control and bidirectional formatting characters are not allowed");
  }

  return value.normalize("NFC").trim().replace(/\p{Zs}+/gu, " ");
}

export function normalizeNickname(value: string): string {
  const normalized = normalizeDisplayText(value);
  const graphemeCount = countGraphemes(normalized);

  if (graphemeCount < 1 || graphemeCount > MAX_NICKNAME_GRAPHEMES) {
    throw new DisplayNameValidationError(
      `Nickname must contain between 1 and ${MAX_NICKNAME_GRAPHEMES} graphemes`,
    );
  }

  if (encoder.encode(normalized).byteLength > MAX_NICKNAME_BYTES) {
    throw new DisplayNameValidationError(`Nickname must not exceed ${MAX_NICKNAME_BYTES} UTF-8 bytes`);
  }

  return normalized;
}

export const NicknameSchema = z.string().transform((value, context) => {
  try {
    return normalizeNickname(value);
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : "Invalid nickname",
    });
    return z.NEVER;
  }
});
export type Nickname = z.infer<typeof NicknameSchema>;

export function normalizeFileName(value: string): string {
  const normalized = normalizeDisplayText(value);

  if (normalized.length === 0) {
    throw new DisplayNameValidationError("File name must not be empty");
  }
  if (normalized === "." || normalized === ".." || PATH_SEPARATORS.test(normalized)) {
    throw new DisplayNameValidationError("File name must not contain path components");
  }
  if (encoder.encode(normalized).byteLength > MAX_FILE_NAME_BYTES) {
    throw new DisplayNameValidationError(`File name must not exceed ${MAX_FILE_NAME_BYTES} UTF-8 bytes`);
  }

  return normalized;
}

export const FileNameSchema = z.string().transform((value, context) => {
  try {
    return normalizeFileName(value);
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : "Invalid file name",
    });
    return z.NEVER;
  }
});
export type FileName = z.infer<typeof FileNameSchema>;
