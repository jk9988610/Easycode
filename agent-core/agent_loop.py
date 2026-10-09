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
import sys
import time

from deepseek_client import client
from executor import TOOL_MAP, WORKSPACE
from tools import TOOLS

MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-chat")
MAX_TURNS = int(os.environ.get("AGENT_MAX_TURNS", "15"))

SYSTEM_PROMPT = """你是一个代码修改助手,工作在指定的工作区目录下。

# 环境信息
- 操作系统: {os_name}({platform_str})
- Shell: {shell_name}(命令语法必须匹配该 shell,不确定时优先用跨平台工具而非 shell 命令)
- 工作区(路径围栏): {workspace}
- Python: {python_ver}(命令行用 `python` 而不是 `python3`)

# 工具使用规则
1. 修改代码前,先用 read_file 读取文件了解现状
2. 创建新文件必须用 write_file,严禁用 echo / 重定向创建文件
3. 修改已有代码用 edit_file,old_text 必须与 read_file 返回的内容逐字符一致(包括缩进和换行)
4. 查看目录结构用 list_dir,不要用 ls/dir
5. 修改后必须验证,验证命令按改动范围选择:
   - 改 src/**/*.ts (EasyCode 主进程/渲染进程) → run_command("npm run typecheck")
   - 改 agent-core/*.py (Agent 自身) → run_command("python -m py_compile <改动的文件>")
   - 其他文件按项目实际情况选择合适命令
   验证失败则分析错误并继续修复,不得原样重试,更不得在验证失败时报告完成
6. 报告任务完成时,必须在最终回复里写明: 改动文件 + 验证命令 + 验证结果(通过/失败)

# 行为规则
- 只做用户要求的事情,不要擅自修改无关文件
- 不要创建 .bak/.tmp 等临时文件以外的多余产物
- 任务完成或无法继续时,直接给出简洁的文字总结,不要再调用工具
"""


def _build_system_prompt() -> str:
    return SYSTEM_PROMPT.format(
        os_name=os.name,
        platform_str=platform.platform(),
        shell_name="cmd.exe" if os.name == "nt" else "bash/sh",
        workspace=WORKSPACE,
        python_ver=platform.python_version(),
    )


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
        return f"  {_C_BLUE}💭 思考:{_C_RESET} {event['content']}"
    if t == "tool_call":
        return f"  {_C_CYAN}🔧 调用:{_C_RESET} {event['name']}({event['arguments']})"
    if t == "tool_result":
        return f"  {_C_DIM}📄 结果:{_C_RESET} {event['result']}"
    if t == "final":
        return f"\n{_C_GREEN}✅ 助手:{_C_RESET} {event['content']}"
    if t == "stopped":
        return f"\n{_C_YELLOW}⚠️ 达到最大轮次,已停止{_C_RESET}"
    if t == "error":
        return f"\n{_C_RED}❌ 错误:{_C_RESET} {event['message']}"
    if t == "session_started":
        return f"\n{_C_GREEN}🟢 会话已启动{_C_RESET}"
    if t == "ready":
        return f"\n{_C_GREEN}✅ 就绪,等待下一条指令{_C_RESET}"
    return ""


def emit(event: dict) -> None:
    """发出一个结构化事件。stdout=JSONL / stderr=彩色。"""
    event = {"ts": time.time(), **event}
    print(json.dumps(event, ensure_ascii=False), flush=True)
    line = _pretty(event)
    if line:
        print(line, file=sys.stderr, flush=True)


def _pick_content(msg) -> str:
    reasoning = getattr(msg, "reasoning_content", None)
    if reasoning:
        return reasoning
    return (msg.content or "").strip()


# ---------------------------------------------------------------------------
# 对话上下文管理
# ---------------------------------------------------------------------------


def _new_messages() -> list:
    """创建带 system prompt 的消息列表。"""
    return [{"role": "system", "content": _build_system_prompt()}]


def _run_turn(messages: list, turn: int) -> str | None:
    """执行一轮对话(可能包含多次工具调用),返回最终文字或 None。

    messages 列表会被就地追加(user / assistant / tool 消息)。
    """
    for sub_turn in range(turn, turn + MAX_TURNS):
        emit({"type": "turn_start", "turn": sub_turn})
        try:
            response = client.chat.completions.create(
                model=MODEL,
                messages=messages,
                tools=TOOLS,
            )
        except Exception as e:
            emit({"type": "error", "turn": sub_turn, "message": str(e)})
            raise

        msg = response.choices[0].message
        messages.append(msg)

        thinking = _pick_content(msg)
        if thinking:
            emit({"type": "thinking", "turn": sub_turn, "content": thinking})

        if not msg.tool_calls:
            emit({"type": "final", "turn": sub_turn, "content": thinking or "(无文字回复)"})
            return msg.content

        for tool_call in msg.tool_calls:
            func_name = tool_call.function.name
            raw_args = tool_call.function.arguments
            emit({"type": "tool_call", "turn": sub_turn, "id": tool_call.id,
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
                        result = TOOL_MAP[func_name](**func_args)
                    except TypeError as e:
                        result = f"[错误] 参数不匹配: {e}"
            result = str(result)

            emit({"type": "tool_result", "turn": sub_turn, "id": tool_call.id,
                  "name": func_name, "result": result})

            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tool_call.id,
                    "content": result,
                }
            )

    emit({"type": "stopped", "turn": turn + MAX_TURNS})
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
      - stdin 每行一个 JSON: {"type":"send","content":"用户消息"}
                          或 {"type":"clear"} 清空对话历史
                          或 {"type":"exit"} 退出
      - stdout 照常输出 JSONL 事件流(与单次模式相同)
      - 每轮结束后发 {"type":"ready"} 表示可接收下一条指令
    """
    messages = _new_messages()
    emit({"type": "session_started"})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except json.JSONDecodeError as e:
            emit({"type": "error", "message": f"stdin 非 JSON: {e}"})
            continue

        ctype = cmd.get("type", "")
        if ctype == "exit":
            break
        if ctype == "clear":
            messages = _new_messages()
            emit({"type": "ready"})
            continue
        if ctype != "send":
            emit({"type": "error", "message": f"未知指令类型: {ctype}"})
            continue

        content = cmd.get("content", "").strip()
        if not content:
            emit({"type": "ready"})
            continue

        messages.append({"role": "user", "content": content})
        try:
            _run_turn(messages, 1)
        except Exception:
            pass  # 错误已通过 emit 发出,不退出会话
        emit({"type": "ready"})

    emit({"type": "final", "content": "(会话结束)"})
