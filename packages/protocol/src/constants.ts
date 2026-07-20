export const PROTOCOL_VERSION = 2 as const;

export const ROOM_ID_BYTES = 16;
export const LINK_SECRET_BYTES = 32;
export const MEMBER_ID_BYTES = 16;
export const RESUME_TOKEN_BYTES = 32;
export const CHALLENGE_BYTES = 32;
export const ADMISSION_VERIFIER_BYTES = 32;
export const IDENTITY_PUBLIC_KEY_BYTES = 32;
export const ED25519_SIGNATURE_BYTES = 64;
export const XCHACHA20_NONCE_BYTES = 24;
export const SECRETSTREAM_HEADER_BYTES = 24;
export const DIGEST_BYTES = 32;

export const PIN_LENGTH = 6;
export const MAX_ROOM_MEMBERS = 8;
export const DEFAULT_ROOM_TTL_MS = 24 * 60 * 60 * 1_000;
export const MAX_ROOM_TTL_MS = DEFAULT_ROOM_TTL_MS;
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_MISSES_BEFORE_EVICTION = 2;
export const RECONNECT_GRACE_MS = 30_000;
export const PEER_CONNECTION_TIMEOUT_MS = 30_000;

export const DEFAULT_MAX_FILE_SIZE_MB = 25;
export const MIN_MAX_FILE_SIZE_MB = 1;
export const MAX_MAX_FILE_SIZE_MB = 256;
export const MAX_FILE_SIZE_BYTES = MAX_MAX_FILE_SIZE_MB * 1024 * 1024;
export const FILE_CHUNK_SIZE_BYTES = 64 * 1024;

export const MAX_NICKNAME_GRAPHEMES = 24;
export const MAX_NICKNAME_BYTES = 96;
export const MAX_FILE_NAME_BYTES = 255;
export const MAX_RICH_TEXT_BYTES = 32 * 1024;
export const MAX_RICH_TEXT_VISIBLE_BYTES = 8 * 1024;
export const MAX_RICH_TEXT_NODES = 256;
export const MAX_RICH_TEXT_DEPTH = 8;
export const MAX_RICH_TEXT_LINKS = 10;
export const MAX_RICH_TEXT_ATTACHMENTS = 4;
export const MAX_LINK_LENGTH = 2_048;
export const MAX_SIGNAL_SDP_LENGTH = 128 * 1024;
export const MAX_ICE_CANDIDATE_LENGTH = 4_096;
export const MAX_ENCRYPTED_MESSAGE_BYTES = 64 * 1024;

export const PREFERENCES_STORAGE_KEY = "veilink.preferences.v1" as const;
