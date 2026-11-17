"""Agent 循环(核心):指令 → 模型决定调工具 → 执行 → 结果回传 → 直到完成。

两种运行模式:
- 单次模式:run_agent(task) 执行一轮后返回,子进程退出。
- 交互模式:run_interactive() 保持运行,从 stdin 逐行读取新指令,
  在同一个 messages 列表上续写,实现多轮长对话。

输出分离(便于 GUI 集成):
- stdout: 每行一个 JSON 事件(JSONL),供主进程逐行解析转发给 UI。
- stderr: 人类可读的彩色文本,供终端直接调试。
"""
import json
import os
import platform
import queue
import sys
import threading
import time
import uuid

from deepseek_client import client
from executor import TOOL_MAP, WORKSPACE
from repo_map import build_repo_map
from tools import TOOLS, TOOLS_READONLY

MODEL_LIST = [
    m.strip() for m in os.environ.get(
        "AGENT_MODEL_LIST",
        "qiniu/conatus-free,nvidia/nemotron-3-ultra-550b-a55b0-free"
    ).split(",") if m.strip()
]
# 向后兼容：保留 MODEL 指向主模型
MODEL = MODEL_LIST[0] if MODEL_LIST else "qiniu/conatus-free"

# 失败冷却:模型失败后 N 秒内跳过,避免反复撞同一个墙
MODEL_COOLDOWN_SECS = int(os.environ.get("AGENT_MODEL_COOLDOWN", "60"))
_model_cooldown = {}  # {model_name: last_fail_timestamp}


def _pick_model(attempt: int) -> str:
    """按 attempt 轮换模型,跳过仍在冷却期的。全部冷却则返回即将解冻的那个。"""
    now = time.time()
    # 按 attempt 起始偏移轮换,保证 attempt=0 用主模型
    n = len(MODEL_LIST)
    if n == 0:
        return MODEL
    for offset in range(n):
        idx = (attempt + offset) % n
        m = MODEL_LIST[idx]
        last_fail = _model_cooldown.get(m, 0)
        if now - last_fail >= MODEL_COOLDOWN_SECS:
            return m
    # 全部冷却中:返回最早失败的那个(它最接近解冻)
    return min(MODEL_LIST, key=lambda x: _model_cooldown.get(x, 0))


def _mark_model_failed(model_name: str) -> None:
    _model_cooldown[model_name] = time.time()
MAX_TURNS = int(os.environ.get("AGENT_MAX_TURNS", "50"))
MAX_RETRIES = int(os.environ.get("AGENT_MAX_RETRIES", "4"))
RETRY_BASE = float(os.environ.get("AGENT_RETRY_BASE", "2"))  # 秒,指数退避基数

# 上下文压缩参数(字符预算,约等于 token 数)
# qiniu/conatus-free 窗口约 32K token,留一半给 system + 输出,预算 64K 字符
CONTEXT_BUDGET = int(os.environ.get("AGENT_CONTEXT_BUDGET", "64000"))
CONTEXT_SOFT_WATERMARK = float(os.environ.get("AGENT_CTX_SOFT", "0.5"))  # 50% 软压缩
CONTEXT_HARD_WATERMARK = float(os.environ.get("AGENT_CTX_HARD", "0.7"))  # 70% 硬压缩
CONTEXT_KEEP_RECENT = int(os.environ.get("AGENT_CTX_KEEP", "6"))          # 保护最近 6 条

SYSTEM_PROMPT = """你是一个代码修改助手,工作在指定的工作区目录下。

# 环境信息
- 操作系统: {os_name}({platform_str})
- Shell: {shell_name}
- **Windows 下当前 shell 是 cmd.exe**:禁止用 find / grep / ls / cat / rm 等 Linux 命令;
  用 dir / type / findstr / del / rd 等 cmd 命令,或 PowerShell(Get-ChildItem / Select-String)
- **工具选择按意图**:
  - 查看/修改文件、找文件、搜内容 → read_file / edit_file / write_file / find_files / search_code
  - 跑单行命令 → run_command(如 dir、npm run build、git status)
  - 跑多行脚本/统计/批处理/复杂引号 → run_script(language, code),天然支持多行,不用管 shell 转义
  - 命令超过一行、需要引号嵌套、或含循环/条件 → 一律用 run_script,不要用 run_command 硬塞
  - 任务完成时 → attempt_completion(result),附最终总结,本轮立即结束
  - 需要用户决策时(方案选择/删留判断/外部信息) → ask_followup_question(question, options),本轮暂停等用户回答
  - 大 Python 文件按符号读/改 → list_symbols(path) 列符号 / read_symbol(path, name) 读单个 / patch_symbol(path, name, new_body) 改单个,支持 Class.method
  - 改代码前评估影响面 → who_uses(symbol, path),查 symbol 在项目中的引用点(JSON,含 kind/scope)
- **禁止用 python -c 跑多行脚本**:cmd.exe 会把换行当命令分隔符截断,只有第一行执行且退出码仍为 0(静默失败)。多行逻辑用 run_script。
- 工作区(路径围栏): {workspace}
- Python: {python_ver}(命令行用 `python` 而不是 `python3`)

# 工具使用规则
1. 修改代码前,先用 read_file 读取文件了解现状
2. 创建新文件必须用 write_file,严禁用 echo / 重定向创建文件
3. 修改已有代码用 edit_file,old_text 必须与 read_file 返回的内容逐字符一致(包括缩进和换行)。
   若返回"未找到",会附带文件当前片段,直接从片段复制 old_text 重试,不必再 read_file。
4. 查看目录结构用 list_dir,找文件用 find_files,搜内容用 search_code。
   不要用 ls/dir/grep/findstr 等 shell 命令(跨平台不一致且易受编码干扰)。
5. 修改后必须验证,验证命令按改动范围选择:
   - 改 src/**/*.ts (Easycode) → run_command("npm run typecheck")
   - 改 agent-core/*.py (Agent 自身) → run_command("python -m py_compile <改动的文件>")
   - 其他项目按其实际情况选择合适命令(测试/py_compile/tsc 等)
   验证失败则分析错误并继续修复,不得原样重试,更不得在验证失败时报告完成
6. 报告任务完成时,必须在最终回复里写明: 改动文件 + 验证命令 + 验证结果(通过/失败)
7. 需要批量验证多个文件/路径存在性时,**用一次 run_script 批量处理**:
   run_script(language="python", code="import os\nfor f in ['a.py','b.md']:\n    print(f, os.path.exists(f))")
   不要用 N 次 list_dir 逐个确认——多轮无意义探索会耗尽轮次预算
8. 遇到以下任一情况,**必须先** memory(op="search", ...) 查经验,查到就按记忆走:
   - 要修改不熟悉的模块/文件
   - 遇到报错、行为异常、结果不符预期
   - 用户问「有什么坑/注意事项/历史问题/该看哪个文件」
   0 条命中再按自己判断继续。
9. 任务完成后,若发现可复用的教训(踩坑/时序/跨模块约束/反直觉行为),
   用 memory(op="write", title="[TRAP] ...", tags=[...], sections 含 现象/根因/修复/文件/验证/教训) 记一条。
   记忆写入不走审批,直接写 .agent/memory.json;改代码文件仍走审批。
10. 如果按记忆中的 [TRAP]/[BUG] 条目修复了问题,并在验证通过后确认现象消失,
    用 memory(op="write", title=<原 title 原文>, memory_status="resolved") 更新状态。
    按 title 合并,不要另建新条目。
11. 修改 Easycode 自身代码(src/**/*.ts 或 agent-core/*.py)后,验证通过并且需要立即生效时,
    调用 restart_self 触发主进程重启。restart_self 会重启整个 Easycode,当前对话会中断,
    仅当用户明确需要立即生效或你自己验证需要重启时才调用。

# 行为规则
- 只做用户要求的事情,不要擅自修改无关文件
- **不要顺手美化/重构/补充说明**——任务没要求的不做
- **但发现文档与实际不符、链接失效、遗漏重要条目时,应修正**(这是任务核心)
- 不要创建 .bak/.tmp 等多余产物
  (注: write_file/edit_file 工具会自动生成 .bak 备份用于回滚,这是工具行为,
   不要手动删除或清理它,否则会破坏回滚能力)
- 任务完成时调用 attempt_completion(result) 附最终总结,本轮立即结束;
  无法继续时直接给出简洁文字总结,不要再调用工具
- **每轮工具调用前自查**:这一步是「完成用户任务」还是「了解一下项目」?
  如果是后者,先停下——除非任务明确要求探索,否则不要读无关文件/插件源码
- **首次工具调用后的第 2 轮**:心里默念用户的原始任务,确认没跑偏
- **超过 5 轮还没产出(edit_file / write_file / 明确回答)**:说明在漂移,立刻回到任务本身
"""



PLAN_PROMPT = """
# 当前模式: 规划(Plan)
你现在处于规划模式,**只能调查和思考,不能修改任何文件或执行命令**。
可用工具仅限只读:read_file / list_dir / search_code / find_files / memory。

请按以下步骤输出一份可执行的修改计划:
1. 用只读工具调研相关文件和代码,弄清现状。
2. 输出计划,格式严格如下(不要输出多余寒暄):

## 修改计划
1. [文件路径] 具体改什么、为什么
2. ...

## 验证方式
- 改完后跑什么命令验证

不要调用 write_file / edit_file / run_command。计划输出后本轮结束,等待用户批准。
"""

def _build_system_prompt() -> str:
    base = SYSTEM_PROMPT.format(
        os_name=os.name,
        platform_str=platform.platform(),
        shell_name="cmd.exe" if os.name == "nt" else "bash/sh",
        workspace=WORKSPACE,
        python_ver=platform.python_version(),
    )
    if os.environ.get("AGENT_REPO_MAP", "1") != "0":
        try:
            rm = build_repo_map(WORKSPACE)
        except Exception:
            rm = ""
        if rm:
            base += (
                "\n# 项目结构(自动生成,仅供导航)\n"
                "以下是工作区文件骨架(目录 + 行数 + 顶层符号)。"
                "先据此判断该读哪个文件,不要盲目逐层 list_dir。\n\n" + rm + "\n"
            )
    return base


# ---------------------------------------------------------------------------
# 结构化日志:stdout=JSONL(供解析)/ stderr=彩色(供调试)
# ---------------------------------------------------------------------------

_C_RESET = "\033[0m"
_C_DIM = "\033[2m"
_C_CYAN = "\033[36m"
_C_YELLOW = "\033[33m"
_C_GREEN = "\033[32m"
_C_RED = "\033[31m"
_C_BLUE = "\033[34m"


def _pretty(event: dict) -> str:
    t = event["type"]
    if t == "turn_start":
        return f"\n{_C_DIM}--- 第 {event['turn']} 轮 ---{_C_RESET}"
    if t == "thinking":
        return f"  {_C_BLUE}[思考]{_C_RESET} {event['content']}"
    if t == "tool_call":
        return f"  {_C_CYAN}[工具]{_C_RESET} {event['name']}({event['arguments']})"
    if t == "tool_result":
        return f"  {_C_DIM}[结果]{_C_RESET} {event['result']}"
    if t == "final":
        return f"\n{_C_GREEN}[AI]{_C_RESET} {event['content']}"
    if t == "stopped":
        return f"\n{_C_YELLOW}[警告] 达到最大轮次,已停止{_C_RESET}"
    if t == "retry":
        return (f"  {_C_YELLOW}⏳ 重试 {event['attempt']}/{MAX_RETRIES} "
                f"(等待 {event['wait']}s):{_C_RESET} {event.get('reason', '')}")
    if t == "error":
        return f"\n{_C_RED}[错误]{_C_RESET} {event['message']}"
    if t == "session_started":
        return f"\n{_C_GREEN}[会话] 已启动{_C_RESET}"
    if t == "ready":
        return f"\n{_C_GREEN}[就绪] 等待下一条指令{_C_RESET}"
    return ""


def emit(event: dict) -> None:
    """发出一个结构化事件。stdout=JSONL / stderr=彩色。"""
    event = {"ts": time.time(), **event}
    print(json.dumps(event, ensure_ascii=False), flush=True)
    line = _pretty(event)
    if line:
        print(line, file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# 上下文压缩:防止长会话爆窗口。
#
# 策略(参考 SWE-agent history processor):
#   - 保护最近 CONTEXT_KEEP_RECENT 条消息(当前轮上下文完整)
#   - 50% 水位:软裁剪最老的 tool 消息(保留头 500 + 尾 200,中间占位)
#   - 70% 水位:硬裁剪所有旧 tool 消息(只留前 200 字符)
#   - 不删任何消息,保持 assistant tool_calls / tool tool_call_id 配对完整
# ---------------------------------------------------------------------------


def _estimate_chars(messages: list) -> int:
    """粗估 messages 总字符数(content + tool_call arguments)。"""
    total = 0
    for m in messages:
        if isinstance(m, dict):
            content = m.get("content") or ""
            if isinstance(content, str):
                total += len(content)
            for tc in (m.get("tool_calls") or []):
                fn = tc.get("function") or {}
                total += len(fn.get("arguments") or "")
                total += len(fn.get("name") or "")
        else:
            content = getattr(m, "content", None) or ""
            if isinstance(content, str):
                total += len(content)
    return total


def _soft_trim(content: str) -> str:
    """软压缩:保留头 500 + 尾 200,中间占位。"""
    if len(content) <= 800:
        return content
    return content[:500] + f"\n...[已压缩,省略 {len(content) - 700} 字符]...\n" + content[-200:]


def _hard_trim(content: str) -> str:
    """硬压缩:只保留前 200 字符。"""
    if len(content) <= 200:
        return content
    return content[:200] + f"\n...[已硬压缩,原始 {len(content)} 字符]..."


def _compact_messages(messages: list) -> None:
    """就地压缩 messages。达到水位才动手,并打印压缩摘要。"""
    total = _estimate_chars(messages)
    soft_threshold = int(CONTEXT_BUDGET * CONTEXT_SOFT_WATERMARK)
    hard_threshold = int(CONTEXT_BUDGET * CONTEXT_HARD_WATERMARK)

    if total <= soft_threshold:
        return

    use_hard = total >= hard_threshold
    protect_from = max(1, len(messages) - CONTEXT_KEEP_RECENT)

    trimmed = 0
    for i in range(1, protect_from):  # 跳过 system(索引 0)
        m = messages[i]
        if not isinstance(m, dict) or m.get("role") != "tool":
            continue
        content = m.get("content")
        if not isinstance(content, str) or len(content) < 500:
            continue
        new_content = _hard_trim(content) if use_hard else _soft_trim(content)
        if new_content != content:
            m["content"] = new_content
            trimmed += 1

    if trimmed:
        new_total = _estimate_chars(messages)
        print(
            f"[compact] {trimmed} 条旧 tool 消息已{'硬' if use_hard else '软'}压缩: "
            f"{total} -> {new_total} 字符",
            file=sys.stderr, flush=True,
        )


# ---------------------------------------------------------------------------
# 双通道 stdin:主线程跑 agent,子线程读 stdin 入队。
# 审批时主线程阻塞等 approval_response,不会丢用户消息。
# ---------------------------------------------------------------------------

_APPROVAL_CHANNEL = None  # 交互模式下由 run_interactive 设置


class _MsgQueue:
    """stdin 双通道:主线程跑 agent,子线程读 stdin 进 queue。"""

    def __init__(self):
        self.q = queue.Queue()
        self.closed = False

    def start(self, stream):
        def _loop():
            for line in stream:
                line = line.strip()
                if line:
                    self.q.put(line)
            self.closed = True
            self.q.put(None)
        threading.Thread(target=_loop, daemon=True).start()

    def _get(self, timeout=None):
        try:
            return self.q.get(timeout=timeout), True
        except queue.Empty:
            return None, False

    def next_cmd(self):
        while True:
            line, ok = self._get()
            if not ok:
                continue
            if line is None:
                return None
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                continue

    def wait_approval(self, aid, timeout=300):
        """阻塞等指定 id 的 approval_response。返回 bool。超时返回 False。"""
        deadline = time.time() + timeout
        while time.time() < deadline:
            line, ok = self._get(timeout=1.0)
            if not ok:
                continue
            if line is None:
                return False
            try:
                cmd = json.loads(line)
            except json.JSONDecodeError:
                continue
            if cmd.get("type") == "approval_response" and cmd.get("id") == aid:
                return bool(cmd.get("approved"))
        return False

    def wait_answer(self, aid, timeout=300):
        """阻塞等指定 id 的 question_response。返回 str 或 None(超时/关闭)。"""
        deadline = time.time() + timeout
        while time.time() < deadline:
            line, ok = self._get(timeout=1.0)
            if not ok:
                continue
            if line is None:
                return None
            try:
                cmd = json.loads(line)
            except json.JSONDecodeError:
                continue
            if cmd.get("type") == "question_response" and cmd.get("id") == aid:
                return str(cmd.get("answer", ""))
        return None


def _dispatch_tool(func_name, func_args):
    """写文件类工具走审批;其余直接执行。单次模式(_APPROVAL_CHANNEL=None)不走审批。"""
    if _APPROVAL_CHANNEL is not None and func_name in ("write_file", "edit_file", "patch_symbol"):
        return _approval_gate(func_name, func_args)

    if func_name == "ask_followup_question":
        if _APPROVAL_CHANNEL is None:
            return "[不可用] 当前为单次模式,无法向用户提问"
        return _question_gate(func_args.get("question", ""), func_args.get("options"))
    return TOOL_MAP[func_name](**func_args)



def _approval_gate(func_name, func_args):
    """发 approval_request,阻塞等 approval_response。超时按拒绝处理。"""
    from executor import preview_write, preview_edit
    path = str(func_args.get("path", ""))
    if func_name == "write_file":
        diff, err = preview_write(path, func_args.get("content", ""),
                                  func_args.get("encoding", "utf-8"))
    elif func_name == "patch_symbol":
        diff, err = TOOL_MAP["patch_symbol"](
            path, func_args.get("name", ""),
            func_args.get("new_body", ""), dry_run=True)
    else:
        diff, err = preview_edit(path, func_args.get("old_text", ""),
                                 func_args.get("new_text", ""))

    if err:
        return err
    aid = uuid.uuid4().hex[:8]
    emit({"type": "approval_request", "id": aid, "tool": func_name,
          "path": path, "diff": diff})
    print("\n" + "=" * 60, file=sys.stderr, flush=True)
    print("[审批待确认] %s -> %s" % (func_name, path), file=sys.stderr, flush=True)
    print(diff, file=sys.stderr, flush=True)
    print("=" * 60, file=sys.stderr, flush=True)
    approved = _APPROVAL_CHANNEL.wait_approval(aid, timeout=300)
    emit({"type": "approval_result", "id": aid, "approved": approved})
    if not approved:
        return "[拒绝] 用户拒绝或超时未响应,本次修改未执行"
    return TOOL_MAP[func_name](**func_args)


def _question_gate(question, options=None):
    """发 question_request,阻塞等 question_response。超时返回超时提示。"""
    qid = uuid.uuid4().hex[:8]
    emit({"type": "question_request", "id": qid, "question": question,
          "options": options or []})
    print("\n" + "=" * 60, file=sys.stderr, flush=True)
    print("[等待回答] %s" % question, file=sys.stderr, flush=True)
    print("=" * 60, file=sys.stderr, flush=True)
    answer = _APPROVAL_CHANNEL.wait_answer(qid, timeout=300)
    emit({"type": "question_result", "id": qid, "answer": answer})
    if answer is None:
        return "[超时] 用户未回答,请自行决定或结束本轮"
    return answer


# ---------------------------------------------------------------------------
# 对话上下文管理
# ---------------------------------------------------------------------------



def _new_messages() -> list:
    """创建带 system prompt 的消息列表。"""
    return [{"role": "system", "content": _build_system_prompt()}]


def _run_turn(messages: list, turn: int, mode: str = "act") -> str | None:
    """执行一轮对话(可能包含多次工具调用),返回最终文字或 None。

    messages 列表会被就地追加(user / assistant / tool 消息)。
    """
    for sub_turn in range(turn, turn + MAX_TURNS):
        # 每轮开始前检查上下文水位,超标就先压缩(不阻塞,只调字符数)
        _compact_messages(messages)
        emit({"type": "turn_start", "turn": sub_turn})
        active_tools = TOOLS_READONLY if mode == "plan" else TOOLS
        stream = None
        last_err = None
        for attempt in range(MAX_RETRIES + 1):
            current_model = _pick_model(attempt)
            try:
                stream = client.chat.completions.create(
                    model=current_model,
                    messages=messages,
                    tools=active_tools,
                    stream=True,
                )
                if attempt > 0:
                    emit({"type": "info",
                          "message": f"已切换到模型 {current_model} (第 {attempt + 1} 次尝试)"})
                break
            except Exception as e:
                last_err = e
                msg_str = str(e)
                is_retryable = any(k in msg_str for k in (
                    "429", "Too many requests", "rate limit", "Rate limit",
                    "503", "502", "504", "timeout", "Timeout", "temporarily",
                ))
                if not is_retryable or attempt >= MAX_RETRIES:
                    emit({"type": "error", "turn": sub_turn, "message": msg_str})
                    raise
                _mark_model_failed(current_model)
                import random as _random
                wait = RETRY_BASE * (2 ** attempt) + _random.uniform(0, 1)
                next_model = _pick_model(attempt + 1)
                emit({"type": "retry", "turn": sub_turn, "attempt": attempt + 1,
                      "wait": round(wait, 1),
                      "reason": f"{msg_str[:100]} | {current_model} 冷却 {MODEL_COOLDOWN_SECS}s | 下次: {next_model}"})
                time.sleep(wait)
        if stream is None:
            emit({"type": "error", "turn": sub_turn, "message": str(last_err)})
            raise last_err

        # 消费流式响应:文本/思考逐 chunk emit,tool_calls 按 index 聚合分片
        text_chunks: list = []
        reasoning_chunks: list = []
        tool_calls_acc: dict = {}
        try:
            for chunk in stream:
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta
                if delta is None:
                    continue
                # 思考内容(部分模型支持)
                reasoning = getattr(delta, "reasoning_content", None)
                if reasoning:
                    reasoning_chunks.append(reasoning)
                    emit({"type": "thinking_delta", "turn": sub_turn, "delta": reasoning})
                # 正文
                if delta.content:
                    text_chunks.append(delta.content)
                    emit({"type": "text_delta", "turn": sub_turn,
                          "content_index": 0, "delta": delta.content})
                # 工具调用分片
                if delta.tool_calls:
                    for tc in delta.tool_calls:
                        idx = tc.index if tc.index is not None else 0
                        acc = tool_calls_acc.setdefault(
                            idx, {"id": "", "name": "", "arguments": ""})
                        if tc.id:
                            acc["id"] = tc.id
                        if tc.function:
                            if tc.function.name:
                                acc["name"] += tc.function.name
                            if tc.function.arguments:
                                acc["arguments"] += tc.function.arguments
        except Exception as e:
            emit({"type": "error", "turn": sub_turn,
                  "message": f"流式读取中断: {e}"})
            raise

        full_text = "".join(text_chunks)
        full_reasoning = "".join(reasoning_chunks)

        # 构造干净的 assistant 消息为 dict(qiniu 兼容层要求纯 dict)
        assistant_msg = {"role": "assistant", "content": full_text}
        if tool_calls_acc:
            assistant_msg["tool_calls"] = [
                {
                    "id": acc["id"] or f"call_{i}",
                    "type": "function",
                    "function": {
                        "name": acc["name"],
                        "arguments": acc["arguments"],
                    },
                }
                for i, acc in sorted(tool_calls_acc.items())
            ]
        messages.append(assistant_msg)

        # thinking 兜底:旧格式(完整内容),供老前端使用
        if full_reasoning.strip():
            emit({"type": "thinking", "turn": sub_turn, "content": full_reasoning.strip()})

        # 无工具调用:本轮结束
        if not tool_calls_acc:
            if full_text:
                emit({"type": "text_end", "turn": sub_turn,
                      "content_index": 0, "content": full_text})
            final_text = full_text.strip()
            emit({"type": "messages_snapshot", "turn": sub_turn,
                  "messages": messages})
            ev = {"type": "final", "turn": sub_turn,
                  "content": final_text or "(无文字回复)"}
            if mode == "plan":
                ev["mode"] = "plan"
            emit(ev)
            return full_text

        # 有工具调用:逐个执行
        for i, acc in sorted(tool_calls_acc.items()):
            func_name = acc["name"]
            raw_args = acc["arguments"]
            tool_call_id = acc["id"] or f"call_{i}"
            emit({"type": "tool_call", "turn": sub_turn, "id": tool_call_id,
                  "name": func_name, "arguments": raw_args})

            try:
                func_args = json.loads(raw_args or "{}")
            except json.JSONDecodeError as e:
                result = f"[错误] 工具参数不是合法 JSON: {e}"
            else:
                if func_name not in TOOL_MAP:
                    result = f"[错误] 未知工具: {func_name}"
                else:
                    try:
                        result = _dispatch_tool(func_name, func_args)
                    except TypeError as e:
                        result = f"[错误] 参数不匹配: {e}"
                    except Exception as e:
                        result = f"[错误] 工具执行失败: {type(e).__name__}: {e}"
            result = str(result)

            emit({"type": "tool_result", "turn": sub_turn, "id": tool_call_id,
                  "name": func_name, "result": result})

            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tool_call_id,
                    "content": result,
                }
            )

            # attempt_completion: 模型显式声明完成,立即结束本轮
            if func_name == "attempt_completion":
                emit({"type": "messages_snapshot", "turn": sub_turn,
                      "messages": messages})
                ev = {"type": "final", "turn": sub_turn,
                      "content": result or "(无总结)"}
                if mode == "plan":
                    ev["mode"] = "plan"
                emit(ev)
                return result


    # 达到最大轮次:强制模型总结一次(不带 tools,只允许输出文字),
    # 避免用户看到"一堆工具调用后突然消失"。总结请求走临时 messages 副本,
    # 不污染原 messages 历史,便于用户下一条消息接着继续。
    emit({"type": "turn_start", "turn": turn + MAX_TURNS})
    summary_messages = messages + [{
        "role": "user",
        "content": (
            "已达到最大工具调用轮次,请立即停止调用工具。"
            "用一段话总结:①已经完成的工作;②遇到的问题;③下一步建议。"
            "不要再调用任何工具,只输出文字。"
        ),
    }]
    summary_text = None
    for attempt in range(MAX_RETRIES + 1):
        current_model = _pick_model(attempt)
        try:
            summary_resp = client.chat.completions.create(
                model=current_model,
                messages=summary_messages,
            )
            summary_msg = summary_resp.choices[0].message
            summary_text = (summary_msg.content or "").strip()
            break
        except Exception as e:
            msg_str = str(e)
            is_retryable = any(k in msg_str for k in (
                "429", "Too many requests", "rate limit", "Rate limit",
                "503", "502", "504", "timeout", "Timeout", "temporarily",
            ))
            if not is_retryable or attempt >= MAX_RETRIES:
                emit({"type": "error", "turn": turn + MAX_TURNS,
                      "message": f"总结请求失败: {msg_str[:200]}"})
                break
            _mark_model_failed(current_model)
            import random as _random
            wait = RETRY_BASE * (2 ** attempt) + _random.uniform(0, 1)
            emit({"type": "retry", "turn": turn + MAX_TURNS, "attempt": attempt + 1,
                  "wait": round(wait, 1), "reason": f"总结重试: {current_model} 失败 | {msg_str[:60]}"})
            time.sleep(wait)

    if summary_text:
        emit({"type": "messages_snapshot", "turn": turn + MAX_TURNS,
              "messages": messages})
        emit({"type": "final", "turn": turn + MAX_TURNS, "content": summary_text})
        return summary_text

    emit({"type": "stopped", "turn": turn + MAX_TURNS,
          "message": f"达到最大轮次 {MAX_TURNS},总结也失败,本轮任务未完成"})
    return None


# ---------------------------------------------------------------------------
# 单次模式 / 交互模式
# ---------------------------------------------------------------------------


def run_agent(user_input: str, max_turns: int = MAX_TURNS) -> str | None:
    """单次模式:执行一个任务后返回。"""
    messages = _new_messages()
    messages.append({"role": "user", "content": user_input})
    return _run_turn(messages, 1)


def run_interactive() -> None:
    """交互模式:保持运行,从 stdin 逐行读取指令,在同一 messages 上续写。

    协议:
      - stdin 每行一个 JSON:
          {"type":"send","content":"用户消息","mode":"act"|"plan"}
          {"type":"clear"}                       清空对话历史
          {"type":"exit"}                        退出
          {"type":"approval_response","id":"...","approved":true|false}
      - stdout 照常输出 JSONL 事件流
      - 每轮结束后发 {"type":"ready"} 表示可接收下一条指令
    """
    global _APPROVAL_CHANNEL
    messages = _new_messages()
    _APPROVAL_CHANNEL = _MsgQueue()
    _APPROVAL_CHANNEL.start(sys.stdin)
    emit({"type": "session_started"})

    while True:
        cmd = _APPROVAL_CHANNEL.next_cmd()
        if cmd is None:
            break
        ctype = cmd.get("type", "")
        if ctype == "exit":
            break
        if ctype == "clear":
            messages = _new_messages()
            emit({"type": "ready"})
            continue
        if ctype == "restore":
            raw = cmd.get("messages")
            if isinstance(raw, list) and raw:
                if raw[0].get("role") == "system":
                    messages = raw
                else:
                    messages = [{"role": "system", "content": _build_system_prompt()}] + raw
                emit({"type": "restored", "count": len(messages)})
            else:
                messages = _new_messages()
                emit({"type": "error", "message": "restore 缺少 messages"})
            emit({"type": "ready"})
            continue
        # approval_response 由 _approval_gate 内部消费,主循环看到时说明过期,忽略
        if ctype == "approval_response":
            continue
        if ctype != "send":
            emit({"type": "error", "message": f"未知指令类型: {ctype}"})
            continue

        content = cmd.get("content", "").strip()
        if not content:
            emit({"type": "ready"})
            continue

        mode = cmd.get("mode", "act")
        if mode not in ("plan", "act"):
            mode = "act"

        if mode == "plan":
            # 用 user 角色而非 system:qiniu 可能要求 system 必须在 messages[0]
            messages.append({"role": "user",
                             "content": PLAN_PROMPT + "\n\n用户请求:\n" + content})
            try:
                _run_turn(messages, 1, mode="plan")
            except Exception:
                pass
        else:
            messages.append({"role": "user", "content": content})
            try:
                _run_turn(messages, 1, mode="act")
            except Exception:
                pass
        emit({"type": "ready"})

    _APPROVAL_CHANNEL = None
    emit({"type": "final", "content": "(会话结束)"})
