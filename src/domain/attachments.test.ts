import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ATTACHMENT_CAPTION_CHARS,
  MAX_ATTACHMENT_DATA_CHARS,
  MAX_ATTACHMENTS_PER_ENTITY,
  attachmentEntityKey,
  canAddAttachment,
  estimateAttachmentBytes,
  formatAttachmentSize,
  isAttachmentEntityType,
  mimeFromDataUrl,
  remainingAttachmentSlots,
  validateAttachmentCaption,
  validateAttachmentDataUrl,
} from "./attachments.ts";

describe("domain/attachments 純函式與上限邏輯", () => {
  test("attachmentEntityKey 產生穩定鍵", () => {
    assert.equal(attachmentEntityKey("ticket:entry", "e-1"), "ticket:entry:e-1");
    assert.equal(attachmentEntityKey("timetable:block", "b-2"), "timetable:block:b-2");
    assert.equal(isAttachmentEntityType("ticket:entry"), true);
    assert.equal(isAttachmentEntityType("timetable:block"), true);
    assert.equal(isAttachmentEntityType("node"), false);
  });

  test("canAddAttachment 與 remainingAttachmentSlots 嚴守 MAX_ATTACHMENTS_PER_ENTITY (4)", () => {
    assert.equal(MAX_ATTACHMENTS_PER_ENTITY, 4);
    assert.equal(canAddAttachment(0), true);
    assert.equal(canAddAttachment(3), true);
    assert.equal(canAddAttachment(4), false);
    assert.equal(canAddAttachment(7), false);
    assert.equal(remainingAttachmentSlots(0), 4);
    assert.equal(remainingAttachmentSlots(2), 2);
    assert.equal(remainingAttachmentSlots(4), 0);
    assert.equal(remainingAttachmentSlots(9), 0);
  });

  test("validateAttachmentCaption 轉單行、去空白、截斷超長圖說", () => {
    assert.equal(validateAttachmentCaption(null), "");
    assert.equal(validateAttachmentCaption("   \n\t  "), "");
    assert.equal(validateAttachmentCaption("  咖啡館\n窗邊\t票根  "), "咖啡館 窗邊 票根");
    const longText = "あ".repeat(MAX_ATTACHMENT_CAPTION_CHARS + 25);
    assert.equal(Array.from(validateAttachmentCaption(longText)).length, MAX_ATTACHMENT_CAPTION_CHARS);
  });

  test("validateAttachmentDataUrl 驗證格式與上限", () => {
    const okWebp = "data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=";
    assert.equal(validateAttachmentDataUrl(okWebp), okWebp);
    assert.equal(mimeFromDataUrl(okWebp), "image/webp");
    assert.ok(estimateAttachmentBytes(okWebp) > 0);

    const okSvg = "data:image/svg+xml;base64,PHN2Zy8+";
    assert.equal(validateAttachmentDataUrl(okSvg), okSvg);
    assert.equal(mimeFromDataUrl(okSvg), "image/svg+xml");

    assert.throws(() => validateAttachmentDataUrl(""), RangeError);
    assert.throws(() => validateAttachmentDataUrl("https://example.com/a.jpg"), RangeError);
    assert.throws(() => validateAttachmentDataUrl("data:text/plain;base64,SGVsbG8="), RangeError);

    const tooBig = "data:image/webp;base64," + "A".repeat(MAX_ATTACHMENT_DATA_CHARS);
    assert.throws(() => validateAttachmentDataUrl(tooBig), RangeError);
  });

  test("formatAttachmentSize 格式化位元組", () => {
    assert.equal(formatAttachmentSize(null), "");
    assert.equal(formatAttachmentSize(0), "");
    assert.equal(formatAttachmentSize(512), "512 B");
    assert.equal(formatAttachmentSize(1536), "1.5 KB");
    assert.equal(formatAttachmentSize(42 * 1024), "42 KB");
    assert.equal(formatAttachmentSize(1.5 * 1024 * 1024), "1.5 MB");
  });
});
