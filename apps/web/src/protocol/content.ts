import { z } from "zod";

import {
  FILE_CHUNK_SIZE_BYTES,
  MAX_ENCRYPTED_MESSAGE_BYTES,
  MAX_FILE_SIZE_BYTES,
  MAX_ICE_CANDIDATE_LENGTH,
  MAX_LINK_LENGTH,
  MAX_REPLY_EXCERPT_BYTES,
  MAX_REPLY_EXCERPT_CODE_POINTS,
  MAX_RICH_TEXT_ATTACHMENTS,
  MAX_RICH_TEXT_BYTES,
  MAX_RICH_TEXT_DEPTH,
  MAX_RICH_TEXT_LINKS,
  MAX_RICH_TEXT_NODES,
  MAX_RICH_TEXT_VISIBLE_BYTES,
  PROTOCOL_VERSION,
} from "./constants.js";
import { base64UrlDecode } from "./encoding.js";
import { FileNameSchema, NicknameSchema } from "./nickname.js";
import {
  AttachmentIdSchema,
  EpochMillisecondsSchema,
  MemberIdSchema,
  MessageIdSchema,
  NonceSchema,
  SecretstreamHeaderSchema,
  SessionIdSchema,
  SignatureSchema,
} from "./primitives.js";

const encoder = new TextEncoder();

const boundedBase64Url = (maxBytes: number) =>
  z
    .string()
    .min(1)
    .max(Math.ceil(maxBytes * 1.34))
    .refine((value) => {
      try {
        return base64UrlDecode(value).byteLength <= maxBytes;
      } catch {
        return false;
      }
    }, "Expected canonical base64url payload within the byte limit");

export function isSafeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.hostname.length > 0 &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  } catch {
    return false;
  }
}

export const HttpUrlSchema = z
  .string()
  .max(MAX_LINK_LENGTH)
  .refine(isSafeHttpUrl, "Link must be an HTTP(S) URL without embedded credentials");

const BoldMarkSchema = z.object({ type: z.literal("bold") }).strict();
const ItalicMarkSchema = z.object({ type: z.literal("italic") }).strict();
const StrikeMarkSchema = z.object({ type: z.literal("strike") }).strict();
const CodeMarkSchema = z.object({ type: z.literal("code") }).strict();
const LinkMarkSchema = z
  .object({
    type: z.literal("link"),
    attrs: z
      .object({
        href: HttpUrlSchema,
        title: z.string().max(256).nullable().optional(),
        target: z.literal("_blank").nullable().optional(),
        rel: z.enum(["noopener noreferrer", "noopener noreferrer nofollow"]).nullable().optional(),
        class: z.null().optional(),
      })
      .strict(),
  })
  .strict();

export const RichTextMarkSchema = z.discriminatedUnion("type", [
  BoldMarkSchema,
  ItalicMarkSchema,
  StrikeMarkSchema,
  CodeMarkSchema,
  LinkMarkSchema,
]);
export type RichTextMark = z.infer<typeof RichTextMarkSchema>;

export type InlineNode =
  | { type: "text"; text: string; marks?: RichTextMark[] }
  | { type: "hardBreak" }
  | { type: "emoji"; attrs: { name: string; unicode: string } }
  | { type: "mention"; attrs: { id: z.infer<typeof MemberIdSchema>; label: z.infer<typeof NicknameSchema> } }
  | { type: "attachment"; attrs: { attachmentId: z.infer<typeof AttachmentIdSchema> } };

const TextNodeSchema = z
  .object({
    type: z.literal("text"),
    text: z.string().min(1).max(MAX_RICH_TEXT_VISIBLE_BYTES),
    marks: z.array(RichTextMarkSchema).max(8).optional(),
  })
  .strict();
const HardBreakNodeSchema = z.object({ type: z.literal("hardBreak") }).strict();
const EmojiNodeSchema = z
  .object({
    type: z.literal("emoji"),
    attrs: z.object({ name: z.string().min(1).max(64), unicode: z.string().min(1).max(32) }).strict(),
  })
  .strict();
export const MentionNodeSchema = z
  .object({
    type: z.literal("mention"),
    attrs: z.object({ id: MemberIdSchema, label: NicknameSchema }).strict(),
  })
  .strict();
const AttachmentNodeSchema = z
  .object({
    type: z.literal("attachment"),
    attrs: z.object({ attachmentId: AttachmentIdSchema }).strict(),
  })
  .strict();

export const InlineNodeSchema: z.ZodType<InlineNode, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.discriminatedUnion("type", [
    TextNodeSchema,
    HardBreakNodeSchema,
    EmojiNodeSchema,
    MentionNodeSchema,
    AttachmentNodeSchema,
  ]),
);

export type BlockNode =
  | { type: "paragraph"; content?: InlineNode[] }
  | { type: "heading"; attrs: { level: 1 | 2 | 3 }; content: InlineNode[] }
  | { type: "blockquote"; content: BlockNode[] }
  | { type: "codeBlock"; attrs?: { language?: string | null }; content?: Array<{ type: "text"; text: string }> }
  | { type: "bulletList"; content: Array<{ type: "listItem"; content: BlockNode[] }> }
  | {
      type: "orderedList";
      attrs?: { start?: number };
      content: Array<{ type: "listItem"; content: BlockNode[] }>;
    };

const PlainTextNodeSchema = z.object({ type: z.literal("text"), text: z.string().min(1) }).strict();

export const BlockNodeSchema: z.ZodType<BlockNode, z.ZodTypeDef, unknown> = z.lazy(() => {
  const ListItemSchema = z
    .object({ type: z.literal("listItem"), content: z.array(BlockNodeSchema).min(1).max(MAX_RICH_TEXT_NODES) })
    .strict();

  return z.discriminatedUnion("type", [
    z.object({
      type: z.literal("paragraph"),
      content: z.array(InlineNodeSchema).max(MAX_RICH_TEXT_NODES).optional(),
    }).strict(),
    z.object({
      type: z.literal("heading"),
      attrs: z.object({ level: z.union([z.literal(1), z.literal(2), z.literal(3)]) }).strict(),
      content: z.array(InlineNodeSchema).min(1).max(MAX_RICH_TEXT_NODES),
    }).strict(),
    z.object({
      type: z.literal("blockquote"),
      content: z.array(BlockNodeSchema).min(1).max(MAX_RICH_TEXT_NODES),
    }).strict(),
    z.object({
      type: z.literal("codeBlock"),
      attrs: z.object({ language: z.string().max(32).nullable().optional() }).strict().optional(),
      content: z.array(PlainTextNodeSchema).max(MAX_RICH_TEXT_NODES).optional(),
    }).strict(),
    z.object({
      type: z.literal("bulletList"),
      content: z.array(ListItemSchema).min(1).max(MAX_RICH_TEXT_NODES),
    }).strict(),
    z.object({
      type: z.literal("orderedList"),
      attrs: z.object({ start: z.number().int().min(1).max(1_000_000).optional() }).strict().optional(),
      content: z.array(ListItemSchema).min(1).max(MAX_RICH_TEXT_NODES),
    }).strict(),
  ]);
});

export interface RichTextDocument {
  type: "doc";
  content: BlockNode[];
}

export interface RichTextStats {
  jsonBytes: number;
  visibleBytes: number;
  nodeCount: number;
  maxDepth: number;
  linkCount: number;
  attachmentCount: number;
}

export interface RichTextValidationIssue {
  code:
    | "invalid-structure"
    | "document-too-large"
    | "visible-text-too-large"
    | "too-many-nodes"
    | "too-deep"
    | "too-many-links"
    | "too-many-attachments";
  message: string;
}

export type RichTextValidationResult =
  | { success: true; data: RichTextDocument; stats: RichTextStats }
  | { success: false; issues: RichTextValidationIssue[] };

function preflightRichText(input: unknown): Omit<RichTextStats, "jsonBytes"> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }

  const root = input as Record<string, unknown>;
  if (root.type !== "doc" || !Array.isArray(root.content)) {
    return null;
  }

  const stack: Array<{ value: unknown; depth: number }> = root.content.map((value) => ({
    value,
    depth: 1,
  }));
  const seen = new WeakSet<object>();
  let visibleBytes = 0;
  let nodeCount = 0;
  let maxDepth = 0;
  let linkCount = 0;
  let attachmentCount = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (typeof current.value !== "object" || current.value === null || Array.isArray(current.value)) {
      continue;
    }
    if (seen.has(current.value)) {
      return null;
    }
    seen.add(current.value);

    const node = current.value as Record<string, unknown>;
    nodeCount += 1;
    maxDepth = Math.max(maxDepth, current.depth);

    if (nodeCount > MAX_RICH_TEXT_NODES || current.depth > MAX_RICH_TEXT_DEPTH) {
      continue;
    }
    if (node.type === "text" && typeof node.text === "string") {
      visibleBytes += encoder.encode(node.text).byteLength;
    }
    if (node.type === "emoji" && typeof node.attrs === "object" && node.attrs !== null) {
      const unicode = (node.attrs as Record<string, unknown>).unicode;
      if (typeof unicode === "string") {
        visibleBytes += encoder.encode(unicode).byteLength;
      }
    }
    if (node.type === "mention" && typeof node.attrs === "object" && node.attrs !== null) {
      const label = (node.attrs as Record<string, unknown>).label;
      if (typeof label === "string") {
        visibleBytes += encoder.encode(`@${label}`).byteLength;
      }
    }
    if (node.type === "attachment") {
      attachmentCount += 1;
    }
    if (Array.isArray(node.marks)) {
      linkCount += node.marks.filter(
        (mark) => typeof mark === "object" && mark !== null && (mark as Record<string, unknown>).type === "link",
      ).length;
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }

  return { visibleBytes, nodeCount, maxDepth, linkCount, attachmentCount };
}

const RichTextDocumentStructuralSchema = z
  .object({ type: z.literal("doc"), content: z.array(BlockNodeSchema).max(MAX_RICH_TEXT_NODES) })
  .strict();

export function validateRichTextDocument(input: unknown): RichTextValidationResult {
  const statsWithoutSize = preflightRichText(input);
  if (statsWithoutSize === null) {
    return { success: false, issues: [{ code: "invalid-structure", message: "Invalid rich-text document" }] };
  }

  const issues: RichTextValidationIssue[] = [];
  if (statsWithoutSize.nodeCount > MAX_RICH_TEXT_NODES) {
    issues.push({ code: "too-many-nodes", message: `Rich text exceeds ${MAX_RICH_TEXT_NODES} nodes` });
  }
  if (statsWithoutSize.maxDepth > MAX_RICH_TEXT_DEPTH) {
    issues.push({ code: "too-deep", message: `Rich text exceeds depth ${MAX_RICH_TEXT_DEPTH}` });
  }
  if (statsWithoutSize.visibleBytes > MAX_RICH_TEXT_VISIBLE_BYTES) {
    issues.push({
      code: "visible-text-too-large",
      message: `Visible text exceeds ${MAX_RICH_TEXT_VISIBLE_BYTES} UTF-8 bytes`,
    });
  }
  if (statsWithoutSize.linkCount > MAX_RICH_TEXT_LINKS) {
    issues.push({ code: "too-many-links", message: `Rich text exceeds ${MAX_RICH_TEXT_LINKS} links` });
  }
  if (statsWithoutSize.attachmentCount > MAX_RICH_TEXT_ATTACHMENTS) {
    issues.push({
      code: "too-many-attachments",
      message: `Rich text exceeds ${MAX_RICH_TEXT_ATTACHMENTS} attachments`,
    });
  }

  if (issues.length > 0) {
    return { success: false, issues };
  }

  const structural = RichTextDocumentStructuralSchema.safeParse(input);
  if (!structural.success) {
    return {
      success: false,
      issues: structural.error.issues.map((issue) => ({
        code: "invalid-structure",
        message: issue.message,
      })),
    };
  }

  const json = JSON.stringify(structural.data);
  const jsonBytes = encoder.encode(json).byteLength;
  if (jsonBytes > MAX_RICH_TEXT_BYTES) {
    return {
      success: false,
      issues: [{ code: "document-too-large", message: `Rich text exceeds ${MAX_RICH_TEXT_BYTES} bytes` }],
    };
  }

  return { success: true, data: structural.data, stats: { ...statsWithoutSize, jsonBytes } };
}

export const RichTextDocumentSchema = z.unknown().transform((input, context): RichTextDocument => {
  const result = validateRichTextDocument(input);
  if (!result.success) {
    for (const issue of result.issues) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: issue.message });
    }
    return z.NEVER;
  }
  return result.data;
});

export const AttachmentPreviewKindSchema = z.enum(["image", "audio", "video", "pdf", "download"]);
export type AttachmentPreviewKind = z.infer<typeof AttachmentPreviewKindSchema>;

export const ReplyPreviewKindSchema = z.enum(["text", "image", "audio", "video", "pdf", "file"]);
export type ReplyPreviewKind = z.infer<typeof ReplyPreviewKindSchema>;

const REPLY_FORBIDDEN_FORMATTING = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const ReplyExcerptSchema = z
  .string()
  .min(1)
  .refine((value) => value === value.normalize("NFC") && value === value.trim() && value === value.replace(/\p{Zs}+/gu, " "), {
    message: "Reply excerpt must be normalized plain text",
  })
  .refine((value) => !REPLY_FORBIDDEN_FORMATTING.test(value), {
    message: "Reply excerpt must not contain control or bidirectional formatting characters",
  })
  .refine((value) => [...value].length <= MAX_REPLY_EXCERPT_CODE_POINTS, {
    message: `Reply excerpt exceeds ${MAX_REPLY_EXCERPT_CODE_POINTS} code points`,
  })
  .refine((value) => encoder.encode(value).byteLength <= MAX_REPLY_EXCERPT_BYTES, {
    message: `Reply excerpt exceeds ${MAX_REPLY_EXCERPT_BYTES} UTF-8 bytes`,
  });

export const ReplyReferenceSchema = z
  .object({
    messageId: MessageIdSchema,
    senderId: MemberIdSchema,
    senderName: NicknameSchema,
    sentAt: EpochMillisecondsSchema,
    kind: ReplyPreviewKindSchema,
    excerpt: ReplyExcerptSchema,
  })
  .strict();
export type ReplyReference = z.infer<typeof ReplyReferenceSchema>;

export const AttachmentMetadataSchema = z
  .object({
    attachmentId: AttachmentIdSchema,
    fileName: FileNameSchema,
    size: z.number().int().min(1).max(MAX_FILE_SIZE_BYTES),
    mimeType: z
      .string()
      .min(3)
      .max(127)
      .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u),
    previewKind: AttachmentPreviewKindSchema,
    chunkSize: z.literal(FILE_CHUNK_SIZE_BYTES),
    chunkCount: z.number().int().min(1).max(Math.ceil(MAX_FILE_SIZE_BYTES / FILE_CHUNK_SIZE_BYTES)),
    secretstreamHeader: SecretstreamHeaderSchema,
  })
  .strict()
  .refine((value) => value.chunkCount === Math.ceil(value.size / value.chunkSize), {
    message: "Chunk count does not match file size",
    path: ["chunkCount"],
  });
export type AttachmentMetadata = z.infer<typeof AttachmentMetadataSchema>;

export const RichTextMessageSchema = z
  .object({
    type: z.literal("rich-text"),
    document: RichTextDocumentSchema,
    replyTo: ReplyReferenceSchema.optional(),
  })
  .strict();
export type RichTextMessage = z.infer<typeof RichTextMessageSchema>;

export const AttachmentOfferSchema = z
  .object({
    type: z.literal("attachment-offer"),
    attachment: AttachmentMetadataSchema,
    replyTo: ReplyReferenceSchema.optional(),
  })
  .strict();
export type AttachmentOffer = z.infer<typeof AttachmentOfferSchema>;

export const AttachmentTransferStateSchema = z.enum([
  "offered",
  "accepted",
  "declined",
  "transferring",
  "complete",
  "failed",
  "cancelled",
]);

export const AttachmentStateSchema = z
  .object({
    type: z.literal("attachment-state"),
    attachmentId: AttachmentIdSchema,
    state: AttachmentTransferStateSchema,
    transferredBytes: z.number().int().nonnegative().max(MAX_FILE_SIZE_BYTES),
    error: z.string().max(256).optional(),
  })
  .strict();
export type AttachmentState = z.infer<typeof AttachmentStateSchema>;

export const ChatPayloadSchema = z.discriminatedUnion("type", [
  RichTextMessageSchema,
  AttachmentOfferSchema,
  AttachmentStateSchema,
]);
export type ChatPayload = z.infer<typeof ChatPayloadSchema>;

export const EncryptedChatFrameSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    type: z.literal("chat"),
    messageId: MessageIdSchema,
    senderId: MemberIdSchema,
    sessionId: SessionIdSchema,
    counter: z.number().int().nonnegative().safe(),
    sentAt: EpochMillisecondsSchema,
    algorithm: z.literal("XChaCha20-Poly1305-IETF"),
    nonce: NonceSchema,
    ciphertext: boundedBase64Url(MAX_ENCRYPTED_MESSAGE_BYTES),
    signature: SignatureSchema,
  })
  .strict();
export type EncryptedChatFrame = z.infer<typeof EncryptedChatFrameSchema>;

// Kept here so consumers have one bounded string constant for data-channel ICE diagnostics.
export const IceDiagnosticSchema = z.string().max(MAX_ICE_CANDIDATE_LENGTH);
