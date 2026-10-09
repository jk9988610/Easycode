/**
 * AgentHost — 在主进程中管理 agent-core Python 子进程的生命周期。
 *
 * 支持两种模式:
 * 1. 单次模式:run(task) spawn 后等子进程自己结束。
 * 2. 交互模式(长对话):startSession() 启动 `python main.py --interactive`,
 *    保持子进程存活;send(sessionId, message) 通过 stdin 发新指令,
 *    clear(sessionId) 清空历史,stop(sessionId) 终止。
 *
 * 事件流:
 *   渲染进程 ──agent:start──> spawn python --interactive ──stdout──> 逐行解析 JSON
 *        └<──agent:event── 主进程转发事件
 *   渲染进程 ──agent:send──> stdin.write({"type":"send","content":"..."})
 *   渲染进程 ──agent:clear──> stdin.write({"type":"clear"})
 *   渲染进程 ──agent:stop──> kill 子进程
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { resolvePython, resolveAgentCoreDir } from "./pythonRuntime";
import {
  gitRevParseHead,
  gitIsDirty,
  gitStashPush,
  gitStashPop,
  gitStashDrop,
  gitResetHard,
  gitCleanFd,
} from "./git";

export interface AgentEvent {
  ts: number;
  type:
    | "turn_start"
    | "thinking"
    | "tool_call"
    | "tool_result"
    | "final"
    | "verify_result"
    | "stopped"
    | "error"
    | "session_started"
    | "ready";
  turn?: number;
  content?: string;
  name?: string;
  arguments?: string;
  id?: string;
  result?: string;
  message?: string;
  detail?: string;
  ok?: boolean;
}

type EventHandler = (id: string, event: AgentEvent) => void;
type ExitHandler = (id: string, code: number | null) => void;

interface Session {
  id: string;
  proc: ChildProcess;
  cwd: string;
  interactive: boolean;
}

/** agent-core 目录的绝对路径(兼容开发态与打包态)。 */
function requireAgentCoreDir(): string {
  const dir = resolveAgentCoreDir();
  if (!dir) {
    throw new Error(
      "未找到 agent-core 目录(缺少 main.py)。打包版本需确保 agent-core 已复制到 resources 目录。",
    );
  }
  return dir;
}

export class AgentHost {
  private sessions = new Map<string, Session>();
  private seq = 1;
  private pendingPyChanges = new Map<string, Set<string>>();
  private checkpoints = new Map<
    string,
    { cwd: string; headSha: string | null; stashRef: string | null }
  >();
  private onEvent: EventHandler;
  private onExit: ExitHandler;

  constructor(handlers: { onEvent: EventHandler; onExit: ExitHandler }) {
    this.onEvent = handlers.onEvent;
    this.onExit = handlers.onExit;
  }

  /**
   * 启动一个交互式会话(长对话模式)。
   * 子进程保持运行,通过 stdin 接收后续指令。
   */
  startSession(opts: { cwd: string; apiKey: string; model?: string }): string {
    const python = resolvePython();
    if (!python) {
      throw new Error(
        "未找到可用的 Python 解释器。请安装 Python 3 并加入 PATH,或在设置中指定解释器路径(EASYCODE_PYTHON)。",
      );
    }

    const id = `agent-${this.seq++}`;
    const agentDir = requireAgentCoreDir();
    const script = path.join(agentDir, "main.py");

    const env: Record<string, string> = {
      ...process.env,
      DEEPSEEK_API_KEY: opts.apiKey,
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
      AGENT_WORKSPACE: opts.cwd,
    };
    if (opts.model) env.DEEPSEEK_MODEL = opts.model;

    // stdin 必须是 pipe(交互模式需要写入 stdin)
    const proc = spawn(python.command, [...python.args, script, "--interactive"], {
      cwd: opts.cwd,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const session: Session = { id, proc, cwd: opts.cwd, interactive: true };
    this.sessions.set(id, session);
    this.attachStreams(id, proc);

    return id;
  }

  /**
   * 向交互式会话发送一条消息。
   */
  async send(id: string, content: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s || !s.interactive) throw new Error(`会话 ${id} 不存在或不是交互模式`);
    try {
      await this.createCheckpoint(id);
    } catch (e) {
      console.warn("[AgentHost] checkpoint failed:", e);
    }
    const cmd = JSON.stringify({ type: "send", content }) + "\n";
    s.proc.stdin?.write(cmd, "utf-8");
  }

  private async createCheckpoint(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    const cwd = s.cwd;
    const old = this.checkpoints.get(id);
    if (old?.stashRef) {
      try {
        await gitStashDrop(cwd, old.stashRef);
      } catch {
        /* ignore */
      }
    }
    const headSha = await gitRevParseHead(cwd);
    const dirty = await gitIsDirty(cwd);
    let stashRef: string | null = null;
    if (dirty) {
      const stash = await gitStashPush(cwd, `easycode-agent-${id}-${Date.now()}`);
      if (stash.ok && stash.ref) stashRef = stash.ref;
    }
    this.checkpoints.set(id, { cwd, headSha, stashRef });
  }

  async rollback(id: string): Promise<{ ok: boolean; message: string }> {
    const cp = this.checkpoints.get(id);
    if (!cp) return { ok: false, message: "no checkpoint" };
    const cwd = cp.cwd;
    if (cp.headSha) {
      const reset = await gitResetHard(cwd, cp.headSha);
      if (!reset.ok) return { ok: false, message: reset.error || "reset failed" };
    }
    const clean = await gitCleanFd(cwd);
    if (!clean.ok) return { ok: false, message: clean.error || "clean failed" };
    if (cp.stashRef) {
      const pop = await gitStashPop(cwd, cp.stashRef);
      if (!pop.ok) return { ok: false, message: pop.error || "stash pop failed" };
    }
    this.checkpoints.delete(id);
    return { ok: true, message: "rolled back" };
  }

  /**
   * 清空交互式会话的对话历史(不终止进程)。
   */
  clear(id: string): void {
    const s = this.sessions.get(id);
    if (!s || !s.interactive) throw new Error(`会话 ${id} 不存在或不是交互模式`);
    s.proc.stdin?.write(JSON.stringify({ type: "clear" }) + "\n", "utf-8");
  }

  /** 终止指定会话的子进程。 */
  stop(id: string): void {
    this.checkpoints.delete(id);
    const s = this.sessions.get(id);
    if (!s) return;
    // 交互模式:先发 exit 指令优雅退出,再兜底 kill
    if (s.interactive) {
      try {
        s.proc.stdin?.write(JSON.stringify({ type: "exit" }) + "\n", "utf-8");
      } catch {
        /* ignore */
      }
    }
    try {
      s.proc.kill();
    } catch {
      /* ignore */
    }
    this.sessions.delete(id);
  }

  dispose(): void {
    for (const id of [...this.sessions.keys()]) this.stop(id);
  }

  private attachStreams(id: string, proc: ChildProcess): void {
    // stdout: 逐行读 JSONL 事件
    let stdoutBuf = "";
    proc.stdout?.setEncoding("utf-8");
    proc.stdout?.on("data", (chunk: string) => {
      stdoutBuf += chunk;
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.parseAndForward(id, trimmed);
      }
    });

    // stderr: 彩色日志,转发给渲染进程
    proc.stderr?.setEncoding("utf-8");
    proc.stderr?.on("data", (chunk: string) => {
      // stderr 只有调试文本,不转发给 UI(避免噪声)
      // 仅在开发时控制台可见
    });

    proc.on("exit", (code) => {
      const cp = this.checkpoints.get(id);
      if (cp) {
        if (code === 0 && cp.stashRef) {
          gitStashDrop(cp.cwd, cp.stashRef).catch(() => {});
          this.checkpoints.delete(id);
        } else if (code !== 0) {
          this.onEvent(id, {
            ts: Date.now() / 1000,
            type: "error",
            message: `Agent 异常退出（code=${code}）。可用 agent:rollback 回滚。`,
          });
        }
      }
      this.sessions.delete(id);
      this.onExit(id, code);
    });

    proc.on("error", (err) => {
      this.onEvent(id, {
        ts: Date.now() / 1000,
        type: "error",
        message: `子进程启动失败: ${err.message}`,
      });
      this.sessions.delete(id);
      this.onExit(id, -1);
    });
  }

  private parseAndForward(id: string, line: string): void {
    try {
      const event = JSON.parse(line) as AgentEvent;
      this.handleEvent(id, event);
    } catch {
      this.onEvent(id, {
        ts: Date.now() / 1000,
        type: "error",
        message: `[stdout 非预期输出] ${line}`,
      });
    }
  }

  private handleEvent(id: string, event: AgentEvent): void {
    if (event.type === "tool_call" && event.name && event.arguments) {
      this.recordPyChange(id, event.name, event.arguments);
    }
    this.onEvent(id, event);
    if (event.type === "ready") {
      void this.verifyPendingChanges(id);
    }
  }

  private recordPyChange(id: string, toolName: string, argsJson: string): void {
    if (toolName !== "write_file" && toolName !== "edit_file") return;
    try {
      const args = JSON.parse(argsJson) as { path?: string };
      const p = args.path;
      if (!p) return;
      const norm = p.replace(/\\/g, "/");
      if (!/(^|\/)agent-core\/[^/]+\.py$/.test(norm)) return;
      let set = this.pendingPyChanges.get(id);
      if (!set) {
        set = new Set();
        this.pendingPyChanges.set(id, set);
      }
      set.add(p);
    } catch {
      /* ignore */
    }
  }

  private async verifyPendingChanges(id: string): Promise<void> {
    const set = this.pendingPyChanges.get(id);
    if (!set || set.size === 0) return;
    const files = [...set];
    this.pendingPyChanges.delete(id);
    const s = this.sessions.get(id);
    if (!s) return;
    const python = resolvePython();
    if (!python) {
      this.onEvent(id, {
        ts: Date.now() / 1000,
        type: "error",
        message: "无法 py_compile：找不到 Python 解释器",
      });
      return;
    }
    const { spawn } = await import("node:child_process");
    const args = [...python.args, "-m", "py_compile", ...files];
    const proc = spawn(python.command, args, { cwd: s.cwd, windowsHide: true });
    let stderr = "";
    proc.stderr?.on("data", (c) => (stderr += String(c)));
    proc.on("exit", (code) => {
      const names = files.map((f) => f.split(/[\\/]/).pop()).join(", ");
      if (code === 0) {
        this.onEvent(id, {
          ts: Date.now() / 1000,
          type: "verify_result",
          ok: true,
          message: `py_compile 通过：${names}`,
        });
      } else {
        this.onEvent(id, {
          ts: Date.now() / 1000,
          type: "error",
          message: `py_compile 失败：${names}（子进程仍跑旧代码，请修复后重发）`,
          detail: stderr.trim(),
        });
      }
    });
  }

  list(): { id: string; cwd: string }[] {
    return [...this.sessions.values()].map((s) => ({ id: s.id, cwd: s.cwd }));
  }
}
