import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type ShellKind = "powershell" | "cmd" | "gitbash";

export interface TerminalSessionInfo {
  id: string;
  kind: ShellKind;
  title: string;
}

type DataHandler = (id: string, data: string) => void;
type ExitHandler = (id: string, code: number | null) => void;

interface Session {
  id: string;
  kind: ShellKind;
  title: string;
  proc: ChildProcessWithoutNullStreams;
}

/**
 * Lightweight terminal host using child_process (no native node-pty rebuild required).
 * Good enough for cmd / powershell / git-bash inside the bottom panel.
 */
export class TerminalHost {
  private sessions = new Map<string, Session>();
  private seq = 1;
  private onData: DataHandler;
  private onExit: ExitHandler;

  constructor(handlers: { onData: DataHandler; onExit: ExitHandler }) {
    this.onData = handlers.onData;
    this.onExit = handlers.onExit;
  }

  list(): TerminalSessionInfo[] {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      kind: s.kind,
      title: s.title,
    }));
  }

  create(kind: ShellKind, cwd?: string): TerminalSessionInfo {
    const id = `term-${this.seq++}`;
    const workDir =
      cwd && fs.existsSync(cwd) ? cwd : process.env.USERPROFILE || os.homedir();
    const { file, args, title } = resolveShell(kind);
    const proc = spawn(file, args, {
      cwd: workDir,
      env: {
        ...process.env,
        TERM: "xterm-256color",
      },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const session: Session = { id, kind, title, proc };
    this.sessions.set(id, session);

    const push = (buf: Buffer) => {
      this.onData(id, buf.toString("utf-8"));
    };
    proc.stdout.on("data", push);
    proc.stderr.on("data", push);
    proc.on("exit", (code) => {
      this.sessions.delete(id);
      this.onExit(id, code);
    });

    return { id, kind, title };
  }

  write(id: string, data: string): void {
    const s = this.sessions.get(id);
    if (!s || s.proc.killed) return;
    s.proc.stdin.write(data);
  }

  resize(_id: string, _cols: number, _rows: number): void {
    // child_process shells ignore resize; kept for API symmetry with pty
  }

  kill(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    try {
      s.proc.kill();
    } catch {
      /* ignore */
    }
    this.sessions.delete(id);
  }

  dispose(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }
}

function resolveShell(kind: ShellKind): { file: string; args: string[]; title: string } {
  if (kind === "cmd") {
    return { file: process.env.ComSpec || "cmd.exe", args: [], title: "cmd" };
  }
  if (kind === "gitbash") {
    const candidates = [
      process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, "Git", "bin", "bash.exe") : "",
      process.env["ProgramFiles(x86)"]
        ? path.join(process.env["ProgramFiles(x86)"], "Git", "bin", "bash.exe")
        : "",
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "bash.exe",
    ].filter(Boolean);
    const file = candidates.find((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    }) || "bash.exe";
    return { file, args: ["--login", "-i"], title: "Git Bash" };
  }
  // powershell
  const pwsh = [
    path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    "powershell.exe",
    "pwsh.exe",
  ];
  const file = pwsh.find((p) => {
    try {
      return p === "powershell.exe" || p === "pwsh.exe" || fs.existsSync(p);
    } catch {
      return false;
    }
  })!;
  return {
    file,
    args: ["-NoLogo"],
    title: "PowerShell",
  };
}
