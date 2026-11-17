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

// ---- workspace search ----
const TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".txt", ".py",
  ".rs", ".go", ".java", ".c", ".h", ".cpp", ".hpp", ".cs", ".css", ".scss",
  ".html", ".xml", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".sh", ".ps1",
  ".bat", ".cmd", ".sql", ".vue", ".svelte", ".rb", ".php", ".kt", ".swift",
]);

export interface SearchHit {
  path: string; name: string; line?: number; column?: number; preview?: string;
}

export interface SearchOptions {
  query: string; mode: "name" | "content"; caseSensitive?: boolean; maxResults?: number;
}

function walkFiles(root: string, limit: number): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < limit) {
    const dir = stack.pop()!;
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (name === "." || name === "..") continue;
      const full = path.join(dir, name);
      let st: fs.Stats;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        stack.push(full);
      } else if (st.isFile()) {
        out.push(full);
        if (out.length >= limit) break;
      }
    }
  }
  return out;
}

export function searchWorkspace(root: string, opts: SearchOptions): SearchHit[] {
  const raw = (opts?.query || "").trim();
  if (!raw) return [];
  const cs = !!opts.caseSensitive;
  const max = opts.maxResults && opts.maxResults > 0 ? opts.maxResults : 500;
  const needle = cs ? raw : raw.toLowerCase();
  const hits: SearchHit[] = [];
  const files = walkFiles(root, 50000);

  if (opts.mode === "name") {
    for (const f of files) {
      const base = path.basename(f);
      const t = cs ? base : base.toLowerCase();
      if (t.includes(needle)) {
        hits.push({ path: f, name: base });
        if (hits.length >= max) break;
      }
    }
    return hits;
  }

  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (!TEXT_EXT.has(ext)) continue;
    let buf: Buffer;
    try {
      const st = fs.statSync(f);
      if (st.size > 2 * 1024 * 1024) continue;
      buf = fs.readFileSync(f);
    } catch { continue; }
    if (buf.subarray(0, 4096).includes(0)) continue;
    const lines = buf.toString("utf-8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const t = cs ? line : line.toLowerCase();
      const idx = t.indexOf(needle);
      if (idx < 0) continue;
      const preview = line.length > 240 ? line.slice(Math.max(0, idx - 60), idx + 180) : line;
      hits.push({ path: f, name: path.basename(f), line: i + 1, column: idx + 1, preview });
      if (hits.length >= max) return hits;
    }
  }
  return hits;
}
