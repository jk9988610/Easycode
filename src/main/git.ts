import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitFile {
  path: string;
  index: string;
  worktree: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export interface GitStatus {
  ok: boolean;
  error?: string;
  branch?: string;
  files: GitFile[];
}

export interface GitOpResult {
  ok: boolean;
  message: string;
}

type RunOk = { ok: true; stdout: string; stderr: string };
type RunErr = { ok: false; error: string };

async function runGit(cwd: string, args: string[]): Promise<RunOk | RunErr> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      encoding: "utf8",
    });
    return { ok: true, stdout, stderr };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    const msg = (err.stderr || err.message || String(e)).trim();
    return { ok: false, error: msg || "git command failed" };
  }
}

export async function gitStatus(root: string): Promise<GitStatus> {
  if (!root) return { ok: false, error: "no workspace", files: [] };

  const check = await runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  if (!check.ok) return { ok: false, error: "不是 Git 仓库", files: [] };

  const res = await runGit(root, ["status", "--porcelain=v1", "-z", "--branch"]);
  if (!res.ok) return { ok: false, error: res.error, files: [] };

  const files: GitFile[] = [];
  let branch: string | undefined;
  const parts = res.stdout.split("\0");

  for (let i = 0; i < parts.length; i++) {
    const chunk = parts[i];
    if (!chunk) continue;
    if (chunk.startsWith("## ")) {
      const head = chunk.slice(3);
      branch = head.split("...")[0].replace(/^No commits yet on /, "").trim();
      continue;
    }
    if (chunk.length < 3) continue;
    const index = chunk[0];
    const worktree = chunk[1];
    const filePath = chunk.slice(3);
    const untracked = index === "?" && worktree === "?";
    const staged = !untracked && index !== " " && index !== "?";
    const unstaged = !untracked && worktree !== " ";
    files.push({ path: filePath, index, worktree, staged, unstaged, untracked });
  }

  return { ok: true, branch, files };
}

export async function gitStage(root: string, paths: string[]): Promise<GitOpResult> {
  if (!paths.length) return { ok: false, message: "no paths" };
  const res = await runGit(root, ["add", "--", ...paths]);
  return res.ok ? { ok: true, message: "staged" } : { ok: false, message: res.error };
}

export async function gitUnstage(root: string, paths: string[]): Promise<GitOpResult> {
  if (!paths.length) return { ok: false, message: "no paths" };
  const res = await runGit(root, ["restore", "--staged", "--", ...paths]);
  return res.ok ? { ok: true, message: "unstaged" } : { ok: false, message: res.error };
}

export async function gitCommit(root: string, message: string): Promise<GitOpResult> {
  if (!message.trim()) return { ok: false, message: "empty message" };
  const res = await runGit(root, ["commit", "-m", message]);
  return res.ok
    ? { ok: true, message: res.stdout.trim() || "committed" }
    : { ok: false, message: res.error };
}

export async function gitDiff(
  root: string,
  filePath: string,
  staged: boolean,
): Promise<{ ok: boolean; diff?: string; error?: string }> {
  const args = staged ? ["diff", "--cached", "--", filePath] : ["diff", "--", filePath];
  const res = await runGit(root, args);
  return res.ok ? { ok: true, diff: res.stdout } : { ok: false, error: res.error };
}

export async function gitShow(
  root: string,
  rev: string,
  filePath: string,
): Promise<{ ok: boolean; content?: string; error?: string }> {
  if (!root) return { ok: false, error: "no workspace" };
  const res = await runGit(root, ["show", `${rev}:${filePath}`]);
  if (!res.ok) {
    const low = res.error.toLowerCase();
    if (
      low.includes("does not exist") ||
      low.includes("exists on disk") ||
      low.includes("unknown revision") ||
      low.includes("ambiguous argument")
    ) {
      return { ok: true, content: "" };
    }
    return { ok: false, error: res.error };
  }
  return { ok: true, content: res.stdout };
}

export async function gitRevParseHead(root: string): Promise<string | null> {
    const res = await runGit(root, ["rev-parse", "HEAD"]);
    return res.ok ? res.stdout.trim() : null;
  }
  
  export async function gitIsDirty(root: string): Promise<boolean> {
    const res = await runGit(root, ["status", "--porcelain"]);
    return res.ok && res.stdout.trim().length > 0;
  }
  
  export async function gitStashPush(
    root: string,
    message: string,
  ): Promise<{ ok: boolean; ref?: string; error?: string }> {
    const res = await runGit(root, ["stash", "push", "-u", "-m", message]);
    if (!res.ok) return { ok: false, error: res.error };
    if (res.stdout.includes("No local changes")) return { ok: true };
    const list = await runGit(root, ["stash", "list", "-1", "--format=%gd"]);
    return { ok: true, ref: list.ok ? list.stdout.trim() : undefined };
  }
  
  export async function gitStashPop(
    root: string,
    ref?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const args = ref ? ["stash", "pop", ref] : ["stash", "pop"];
    const res = await runGit(root, args);
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  }
  
  export async function gitStashDrop(
    root: string,
    ref?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const args = ref ? ["stash", "drop", ref] : ["stash", "drop"];
    const res = await runGit(root, args);
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  }
  
  export async function gitResetHard(
    root: string,
    rev: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const res = await runGit(root, ["reset", "--hard", rev]);
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  }
  
  export async function gitCleanFd(
    root: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const res = await runGit(root, ["clean", "-fd"]);
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  }