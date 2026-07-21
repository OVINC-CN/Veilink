// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  MAX_RICH_TEXT_ATTACHMENTS,
  AttachmentIdSchema,
  ChatPayloadSchema,
  base64UrlEncode,
  validateRichTextDocument,
} from "./index.js";

const attachmentId = AttachmentIdSchema.parse(base64UrlEncode(new Uint8Array(16).fill(7)));

describe("rich-text validation", () => {
  it("accepts the supported structured format and reports bounded stats", () => {
    const document = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Private room" }],
        },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Official documentation",
              marks: [{ type: "link", attrs: { href: "https://example.com/docs" } }],
            },
            { type: "attachment", attrs: { attachmentId } },
          ],
        },
      ],
    };

    const result = validateRichTextDocument(document);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.stats.linkCount).toBe(1);
      expect(result.stats.attachmentCount).toBe(1);
    }
    expect(ChatPayloadSchema.safeParse({ type: "rich-text", document }).success).toBe(true);
  });

  it("rejects executable links and raw HTML nodes", () => {
    const javascriptLink = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "click",
              marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }],
            },
          ],
        },
      ],
    };
    const html = { type: "doc", content: [{ type: "html", content: "<img onerror=alert(1)>" }] };

    expect(validateRichTextDocument(javascriptLink).success).toBe(false);
    expect(validateRichTextDocument(html).success).toBe(false);
  });

  it("rejects embedded URL credentials", () => {
    const document = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "misleading",
              marks: [{ type: "link", attrs: { href: "https://trusted.example@evil.example/" } }],
            },
          ],
        },
      ],
    };

    expect(validateRichTextDocument(document).success).toBe(false);
  });

  it("enforces aggregate attachment and depth limits before recursive parsing", () => {
    const attachments = Array.from({ length: MAX_RICH_TEXT_ATTACHMENTS + 1 }, () => ({
      type: "attachment",
      attrs: { attachmentId },
    }));
    const tooMany = {
      type: "doc",
      content: [{ type: "paragraph", content: attachments }],
    };

    let nested: unknown = { type: "paragraph", content: [{ type: "text", text: "deep" }] };
    for (let index = 0; index < 10; index += 1) {
      nested = { type: "blockquote", content: [nested] };
    }
    const tooDeep = { type: "doc", content: [nested] };

    expect(validateRichTextDocument(tooMany).success).toBe(false);
    expect(validateRichTextDocument(tooDeep).success).toBe(false);
  });
});
