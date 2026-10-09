const fs = require("fs");
const p = "src/renderer/types.ts";
const s = fs.readFileSync(p, "utf8");
if (s.includes("gitStatus:")) { console.log("already present"); process.exit(0); }
const all = s.split("\n");
const idx = all.findIndex((l) => l.includes("termKill:"));
if (idx === -1) { console.error("termKill not found"); process.exit(1); }
const q = String.fromCharCode(34);
const gitLines = [
  "  gitStatus: (root: string) => Promise<{",
  "    ok: boolean;",
  "    error?: string;",
  "    branch?: string;",
  "    files: {",
  "      path: string;",
  "      index: string;",
  "      worktree: string;",
  "      staged: boolean;",
  "      unstaged: boolean;",
  "      untracked: boolean;",
  "    }[];",
  "  }>;",
  "  gitStage: (root: string, paths: string[]) => Promise<{ ok: boolean; message: string }>;",
  "  gitUnstage: (root: string, paths: string[]) => Promise<{ ok: boolean; message: string }>;",
  "  gitCommit: (root: string, message: string) => Promise<{ ok: boolean; message: string }>;",
  "  gitDiff: (root: string, path: string, staged: boolean) => Promise<{ ok: boolean; diff?: string; error?: string }>;",
  "  gitShow: (root: string, rev: string, path: string) => Promise<{ ok: boolean; content?: string; error?: string }>;",
];
all.splice(idx + 1, 0, ...gitLines);
fs.writeFileSync(p, all.join("\n"), "utf8");
console.log("inserted after line " + (idx + 1));
