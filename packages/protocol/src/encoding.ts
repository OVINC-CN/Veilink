const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;
const MAX_RANDOM_BYTES_PER_CALL = 65_536;

function requireWebCrypto(): Crypto {
  if (typeof globalThis.crypto === "undefined") {
    throw new Error("Web Crypto is unavailable in this environment");
  }

  return globalThis.crypto;
}

function bytesToBinary(bytes: Uint8Array): string {
  const chunks: string[] = [];

  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }

  return chunks.join("");
}

export function base64UrlEncode(bytes: Uint8Array): string {
  return btoa(bytesToBinary(bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function base64UrlDecode(value: string): Uint8Array {
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) {
    throw new TypeError("Invalid base64url value");
  }

  const paddingLength = (4 - (value.length % 4)) % 4;
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat(paddingLength);

  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new TypeError("Invalid base64url value");
  }

  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (base64UrlEncode(bytes) !== value) {
    throw new TypeError("Non-canonical base64url value");
  }

  return bytes;
}

export function randomBytes(length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_RANDOM_BYTES_PER_CALL) {
    throw new RangeError(`Random byte length must be between 1 and ${MAX_RANDOM_BYTES_PER_CALL}`);
  }

  const bytes = new Uint8Array(length);
  requireWebCrypto().getRandomValues(bytes);
  return bytes;
}

export function generateBase64UrlToken(byteLength: number): string {
  return base64UrlEncode(randomBytes(byteLength));
}

export function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }

  return difference === 0;
}
