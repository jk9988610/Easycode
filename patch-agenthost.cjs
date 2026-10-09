const fs = require("fs");
const p = "src/main/agentHost.ts";
let s = fs.readFileSync(p, "utf8");

function must(label, ok) {
  if (!ok) {
    console.error("anchor not found: " + label);
    process.exit(1);
  }
}

// 1) import
const impOld = 'import { resolvePython, resolveAgentCoreDir } from "./pythonRuntime";';
must("import", s.includes(impOld));
s = s.replace(
  impOld,
  [
    impOld,
    "import {",
    "  gitRevParseHead,",
    "  gitIsDirty,",
    "  gitStashPush,",
    "  gitStashPop,",
    "  gitStashDrop,",
    "  gitResetHard,",
    "  gitCleanFd,",
    '} from "./git";',
  ].join("\n"),
);

// 2) checkpoints 字段
const fldOld = [
  "  private sessions = new Map<string, Session>();",
  "  private seq = 1;",
].join("\n");
must("checkpoints field", s.includes(fldOld));
s = s.replace(
  fldOld,
  [
    fldOld,
    "  private checkpoints = new Map<",
    "    string,",
    "    { cwd: string; headSha: string | null; stashRef: string | null }",
    "  >();",
  ].join("\n"),
);

// 3) send 方法替换
const sendOld = [
  "  send(id: string, content: string): void {",
  "    const s = this.sessions.get(id);",
  "    if (!s || !s.interactive) throw new Error(`会话 ${id} 不存在或不是交互模式`);",
  '    const cmd = JSON.stringify({ type: "send", content }) + "\\n";',
  '    s.proc.stdin?.write(cmd, "utf-8");',
  "  }",
].join("\n");
must("send method", s.includes(sendOld));

const sendNew = [
  "  async send(id: string, content: string): Promise<void> {",
  "    const s = this.sessions.get(id);",
  "    if (!s || !s.interactive) throw new Error(`会话 ${id} 不存在或不是交互模式`);",
  "    try {",
  "      await this.createCheckpoint(id);",
  "    } catch (e) {",
  '      console.warn("[AgentHost] checkpoint failed:", e);',
  "    }",
  '    const cmd = JSON.stringify({ type: "send", content }) + "\\n";',
  '    s.proc.stdin?.write(cmd, "utf-8");',
  "  }",
  "",
  "  private async createCheckpoint(id: string): Promise<void> {",
  "    const s = this.sessions.get(id);",
  "    if (!s) return;",
  "    const cwd = s.cwd;",
  "    const old = this.checkpoints.get(id);",
  "    if (old?.stashRef) {",
  "      try {",
  "        await gitStashDrop(cwd, old.stashRef);",
  "      } catch {",
  "        /* ignore */",
  "      }",
  "    }",
  "    const headSha = await gitRevParseHead(cwd);",
  "    const dirty = await gitIsDirty(cwd);",
  "    let stashRef: string | null = null;",
  "    if (dirty) {",
  "      const stash = await gitStashPush(cwd, `easycode-agent-${id}-${Date.now()}`);",
  "      if (stash.ok && stash.ref) stashRef = stash.ref;",
  "    }",
  "    this.checkpoints.set(id, { cwd, headSha, stashRef });",
  "  }",
  "",
  "  async rollback(id: string): Promise<{ ok: boolean; message: string }> {",
  "    const cp = this.checkpoints.get(id);",
  '    if (!cp) return { ok: false, message: "no checkpoint" };',
  "    const cwd = cp.cwd;",
  "    if (cp.headSha) {",
  "      const reset = await gitResetHard(cwd, cp.headSha);",
  '      if (!reset.ok) return { ok: false, message: reset.error || "reset failed" };',
  "    }",
  "    const clean = await gitCleanFd(cwd);",
  '    if (!clean.ok) return { ok: false, message: clean.error || "clean failed" };',
  "    if (cp.stashRef) {",
  "      const pop = await gitStashPop(cwd, cp.stashRef);",
  '      if (!pop.ok) return { ok: false, message: pop.error || "stash pop failed" };',
  "    }",
  "    this.checkpoints.delete(id);",
  '    return { ok: true, message: "rolled back" };',
  "  }",
].join("\n");
s = s.replace(sendOld, sendNew);

// 4) exit handler
const exitOld = [
  '    proc.on("exit", (code) => {',
  "      this.sessions.delete(id);",
  "      this.onExit(id, code);",
  "    });",
].join("\n");
must("exit handler", s.includes(exitOld));
const exitNew = [
  '    proc.on("exit", (code) => {',
  "      const cp = this.checkpoints.get(id);",
  "      if (cp) {",
  "        if (code === 0 && cp.stashRef) {",
  "          gitStashDrop(cp.cwd, cp.stashRef).catch(() => {});",
  "          this.checkpoints.delete(id);",
  "        } else if (code !== 0) {",
  "          this.onEvent(id, {",
  "            ts: Date.now() / 1000,",
  '            type: "error",',
  "            message: `Agent 异常退出（code=${code}）。可用 agent:rollback 回滚。`,",
  "          });",
  "        }",
  "      }",
  "      this.sessions.delete(id);",
  "      this.onExit(id, code);",
  "    });",
].join("\n");
s = s.replace(exitOld, exitNew);

// 5) stop 里清 checkpoints
const stopOld = [
  "  stop(id: string): void {",
  "    const s = this.sessions.get(id);",
  "    if (!s) return;",
].join("\n");
must("stop method", s.includes(stopOld));
s = s.replace(
  stopOld,
  ["  stop(id: string): void {", "    this.checkpoints.delete(id);", "    const s = this.sessions.get(id);", "    if (!s) return;"].join(
    "\n",
  ),
);

fs.writeFileSync(p, s, "utf8");
console.log("patched agentHost.ts");