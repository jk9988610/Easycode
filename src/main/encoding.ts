import iconv from "iconv-lite";
import jschardet from "jschardet";

export type TextEncoding = "utf-8" | "utf-16le" | "gbk" | "gb2312" | "latin1";

const ALIASES: Record<string, TextEncoding> = {
  utf8: "utf-8",
  "utf-8": "utf-8",
  ascii: "utf-8",
  "utf-16le": "utf-16le",
  "utf-16": "utf-16le",
  gbk: "gbk",
  gb2312: "gb2312",
  gb18030: "gbk",
  windows1252: "latin1",
  "iso-8859-1": "latin1",
  latin1: "latin1",
};

export function normalizeEncoding(name: string | undefined | null): TextEncoding {
  if (!name) return "utf-8";
  const key = name.toLowerCase().replace(/[_]/g, "-");
  return ALIASES[key] || "utf-8";
}

export function detectEncoding(buf: Buffer, autoDetect: boolean): TextEncoding {
  if (!autoDetect) return "utf-8";
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return "utf-8";
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return "utf-16le";
  }
  try {
    const sample = buf.subarray(0, Math.min(buf.length, 64 * 1024));
    const hit = jschardet.detect(sample);
    if (hit?.encoding && (hit.confidence ?? 0) >= 0.7) {
      return normalizeEncoding(hit.encoding);
    }
  } catch {
    /* fallthrough */
  }
  // Prefer GBK for common Chinese Windows sources when UTF-8 decode looks broken
  try {
    const asUtf = buf.toString("utf-8");
    if (asUtf.includes("\uFFFD")) return "gbk";
  } catch {
    return "gbk";
  }
  return "utf-8";
}

export function decodeBuffer(buf: Buffer, encoding: TextEncoding): string {
  if (encoding === "utf-8") {
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      return buf.subarray(3).toString("utf-8");
    }
    return buf.toString("utf-8");
  }
  if (encoding === "utf-16le") {
    let start = 0;
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) start = 2;
    return buf.subarray(start).toString("utf16le");
  }
  return iconv.decode(buf, encoding === "gb2312" ? "gb2312" : encoding);
}

export function encodeText(text: string, encoding: TextEncoding): Buffer {
  if (encoding === "utf-8") return Buffer.from(text, "utf-8");
  if (encoding === "utf-16le") {
    return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
  }
  return iconv.encode(text, encoding === "gb2312" ? "gb2312" : encoding);
}
