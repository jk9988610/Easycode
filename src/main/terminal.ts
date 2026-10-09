import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as pty from "@homebridge/node-pty-prebuilt-multiarch";

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
  proc: pty.IPty;
}

/**
 * Terminal host backed by node-pty (real PTY / ConPTY on Windows).
 *
 * Unlike raw child_process with pipe stdio, a PTY makes the shell think
 * it's connected to a real terminal ?so prompts appear, colors work,
 * and Enter/cursor keys are handled correctly by the shell itself.
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

  create(kind: ShellKind, cwd?: string, titleOverride?: string): TerminalSessionInfo {
    const id = `term-${this.seq++}`;
    const workDir =
      cwd && fs.existsSync(cwd) ? cwd : process.env.USERPROFILE || os.homedir();
    const { file, args, title } = resolveShell(kind);
    const useConpty = kind !== "powershell";


    const proc = pty.spawn(file, args, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: workDir,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      } as Record<string, string>,
      useConpty,
    });

    const session: Session = {
      id,
      kind,
      title: titleOverride?.trim() || title,
      proc,
    };
    this.sessions.set(id, session);

    proc.onData((data: string) => {
      this.onData(id, data);
    });
    proc.onExit(({ exitCode }) => {
      this.sessions.delete(id);
      this.onExit(id, exitCode);
    });

    return { id, kind, title };
  }

  write(id: string, data: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.proc.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id);
    if (!s) return;
    try {
      s.proc.resize(cols, rows);
    } catch {
      /* ignore ?resize before spawn completes */
    }
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
      process.env.PROGRAMFILES
        ? path.join(process.env.PROGRAMFILES, "Git", "bin", "bash.exe")
        : "",
      process.env["ProgramFiles(x86)"]
        ? path.join(process.env["ProgramFiles(x86)"], "Git", "bin", "bash.exe")
        : "",
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "bash.exe",
    ].filter(Boolean);
    const file =
      candidates.find((p) => {
        try {
          return fs.existsSync(p);
        } catch {
          return false;
        }
      }) || "bash.exe";
    return { file, args: ["--login", "-i"], title: "Git Bash" };
  }
  const pwshCandidates = [
    process.env.PROGRAMFILES
      ? path.join(process.env.PROGRAMFILES, "PowerShell", "7", "pwsh.exe")
      : "",
    process.env["ProgramFiles(x86)"]
      ? path.join(process.env["ProgramFiles(x86)"], "PowerShell", "7", "pwsh.exe")
      : "",
    // Windows PowerShell 5.1: standard location under System32
    path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
  ].filter(Boolean);
  const file =
    pwshCandidates.find((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    }) || pwshCandidates[pwshCandidates.length - 1];
  const isPwsh7 = file.toLowerCase().includes("powershell\\7\\pwsh.exe");
  return {
    file,
    args: ["-NoLogo"],
    title: isPwsh7 ? "pwsh" : "PowerShell",
  };
}
