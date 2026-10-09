/**
 * AgentHost — 在主进程中管理 agent-core Python 子进程的生命周期。
 *
 * 每个"对话"对应一个子进程。主进程 spawn `python main.py "<task>"`,
 * 逐行读 stdout(JSONL 事件)转发给渲染进程,stderr(彩色日志)写入可选日志。
 *
 * 事件流:
 *   渲染进程 ──agent:run──> 主进程 spawn python ──stdout──> 逐行解析 JSON
 *        └<──agent:event── 主进程转发事件 ──stderr──> 可选写入日志文件
 *   渲染进程 ──agent:stop──> 主进程 kill 子进程
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { app } from "electron";

export interface AgentEvent {
  ts: number;
  type: "turn_start" | "thinking" | "tool_call" | "tool_result" | "final" | "stopped" | "error";
  turn?: number;
  content?: string;
  name?: string;
  arguments?: string;
  id?: string;
  result?: string;
  message?: string;
}

type EventHandler = (id: string, event: AgentEvent) => void;
type ExitHandler = (id: string, code: number | null) => void;

interface Session {
  id: string;
  proc: ChildProcess;
  cwd: string;
}

/** agent-core 目录的绝对路径(开发期指向源码,打包后指向 dist 下副本)。 */
function resolveAgentCoreDir(): string {
  // 开发环境:源码在项目根 agent-core/
  const devPath = path.join(app.getAppPath(), "agent-core");
  return devPath;
}

/**
 * 管理 agent-core 子进程。同一时间可以有多个对话,
 * 每个对话一个独立子进程,互不干扰。
 */
export class AgentHost {
  private sessions = new Map<string, Session>();
  private seq = 1;
  private onEvent: EventHandler;
  private onExit: ExitHandler;

  constructor(handlers: { onEvent: EventHandler; onExit: ExitHandler }) {
    this.onEvent = handlers.onEvent;
    this.onExit = handlers.onExit;
  }

  /**
   * 启动一次 agent 对话。
   *
   * @param task  用户输入的任务描述
   * @param opts  cwd=工作区目录, apiKey=DeepSeek API key
   * @returns     会话 id(渲染进程用它来关联事件流)
   */
  run(task: string, opts: { cwd: string; apiKey: string; model?: string }): string {
    const id = `agent-${this.seq++}`;
    const agentDir = resolveAgentCoreDir();
    const script = path.join(agentDir, "main.py");

    const env: Record<string, string> = {
      ...process.env,
      DEEPSEEK_API_KEY: opts.apiKey,
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
      // agent 的工作区围栏 = 当前打开的工作区
      AGENT_WORKSPACE: opts.cwd,
    };
    if (opts.model) env.DEEPSEEK_MODEL = opts.model;

    const proc = spawn("python", [script, task], {
      cwd: opts.cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const session: Session = { id, proc, cwd: opts.cwd };
    this.sessions.set(id, session);

    // stdout: 逐行读 JSONL 事件
    let stdoutBuf = "";
    proc.stdout.setEncoding("utf-8");
    proc.stdout.on("data", (chunk: string) => {
      stdoutBuf += chunk;
      const lines = stdoutBuf.split("\n");
      // 最后一段可能不完整,保留
      stdoutBuf = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.parseAndForward(id, trimmed);
      }
    });

    // stderr: 彩色日志,直接整块转发给渲染进程(可选展示)
    proc.stderr.setEncoding("utf-8");
    proc.stderr.on("data", (chunk: string) => {
      this.onEvent(id, {
        ts: Date.now() / 1000,
        type: "error",
        message: chunk,
      });
    });

    proc.on("exit", (code) => {
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

    return id;
  }

  /** 终止指定对话的子进程。 */
  stop(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    try {
      s.proc.kill();
    } catch {
      /* ignore */
    }
    this.sessions.delete(id);
  }

  /** 终止所有对话。 */
  dispose(): void {
    for (const id of [...this.sessions.keys()]) this.stop(id);
  }

  private parseAndForward(id: string, line: string): void {
    try {
      const event = JSON.parse(line) as AgentEvent;
      this.onEvent(id, event);
    } catch {
      // 非 JSON 行(stderr 偶尔混入 stdout 或模型输出异常),包装成 error 事件
      this.onEvent(id, {
        ts: Date.now() / 1000,
        type: "error",
        message: `[stdout 非预期输出] ${line}`,
      });
    }
  }

  list(): { id: string; cwd: string }[] {
    return [...this.sessions.values()].map((s) => ({ id: s.id, cwd: s.cwd }));
  }
}
