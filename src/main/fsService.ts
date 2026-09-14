import fs from "node:fs";
import path from "node:path";
import {
  decodeBuffer,
  detectEncoding,
  encodeText,
  normalizeEncoding,
  type TextEncoding,
} from "./encoding";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".vs",
  "dist",
  "dist-electron",
]);

export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface ReadTextResult {
  content: string;
  encoding: TextEncoding;
}

export function listDirChildren(dirPath: string): DirEntry[] {
  const entries: DirEntry[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(dirPath);
  } catch {
    return [];
  }
  for (const name of names) {
    if (name === "." || name === "..") continue;
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dirPath, name);
    let isDirectory = false;
    try {
      isDirectory = fs.statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDirectory && SKIP_DIRS.has(name)) continue;
    entries.push({ name, path: full, isDirectory });
  }
  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
  return entries;
}

export function readTextFile(
  filePath: string,
  opts?: { autoDetectEncoding?: boolean; encoding?: string },
): ReadTextResult {
  const buf = fs.readFileSync(filePath);
  const encoding = opts?.encoding
    ? normalizeEncoding(opts.encoding)
    : detectEncoding(buf, opts?.autoDetectEncoding !== false);
  return { content: decodeBuffer(buf, encoding), encoding };
}

export function writeTextFile(
  filePath: string,
  content: string,
  encoding: string = "utf-8",
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const enc = normalizeEncoding(encoding);
  fs.writeFileSync(filePath, encodeText(content, enc));
}

export function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}
