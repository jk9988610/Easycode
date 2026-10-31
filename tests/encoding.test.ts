import { describe, it, expect } from "vitest";
import {
  normalizeEncoding,
  detectEncoding,
  decodeBuffer,
  encodeText,
} from "../src/main/encoding";

describe("normalizeEncoding", () => {
  it("returns utf-8 for empty / null / undefined", () => {
    expect(normalizeEncoding(undefined)).toBe("utf-8");
    expect(normalizeEncoding(null)).toBe("utf-8");
    expect(normalizeEncoding("")).toBe("utf-8");
  });

  it("aliases common names", () => {
    expect(normalizeEncoding("UTF8")).toBe("utf-8");
    expect(normalizeEncoding("UTF-8")).toBe("utf-8");
    expect(normalizeEncoding("ascii")).toBe("utf-8");
    expect(normalizeEncoding("gb18030")).toBe("gbk");
    expect(normalizeEncoding("ISO-8859-1")).toBe("latin1");
    expect(normalizeEncoding("windows1252")).toBe("latin1");
    expect(normalizeEncoding("utf_16")).toBe("utf-16le");
  });

  it("falls back to utf-8 for unknown", () => {
    expect(normalizeEncoding("klingon")).toBe("utf-8");
  });
});

describe("detectEncoding", () => {
  it("returns utf-8 when autoDetect=false", () => {
    expect(detectEncoding(Buffer.from("hello"), false)).toBe("utf-8");
  });

  it("detects UTF-8 BOM", () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hi")]);
    expect(detectEncoding(buf, true)).toBe("utf-8");
  });

  it("detects UTF-16LE BOM", () => {
    const buf = Buffer.from([0xff, 0xfe, 0x68, 0x00]);
    expect(detectEncoding(buf, true)).toBe("utf-16le");
  });

  it("prefers gbk when utf-8 decode is broken", () => {
    // 0xD6 0xD0 = GBK 中; decoded as utf-8 => U+FFFD
    const buf = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
    expect(detectEncoding(buf, true)).toBe("gbk");
  });
});

describe("decodeBuffer", () => {
  it("strips UTF-8 BOM", () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hi")]);
    expect(decodeBuffer(buf, "utf-8")).toBe("hi");
  });

  it("strips UTF-16LE BOM", () => {
    const buf = Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]);
    expect(decodeBuffer(buf, "utf-16le")).toBe("hi");
  });

  it("decodes gbk bytes", () => {
    const buf = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
    expect(decodeBuffer(buf, "gbk")).toBe("中文");
  });
});

describe("encodeText roundtrip", () => {
  const s = "你好 world";

  it("utf-8", () => {
    expect(decodeBuffer(encodeText(s, "utf-8"), "utf-8")).toBe(s);
  });

  it("utf-16le", () => {
    expect(decodeBuffer(encodeText(s, "utf-16le"), "utf-16le")).toBe(s);
  });

  it("gbk (Chinese only)", () => {
    const cn = "你好";
    expect(decodeBuffer(encodeText(cn, "gbk"), "gbk")).toBe(cn);
  });
});
