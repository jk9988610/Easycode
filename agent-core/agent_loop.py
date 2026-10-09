"""Agent 循环(核心):指令 → 模型决定调工具 → 执行 → 结果回传 → 直到完成。

输出分离(便于 GUI 集成):
- stdout: 每行一个 JSON 事件(JSONL),供主进程逐行解析转发给 UI。
- stderr: 人类可读的彩色文本,供终端直接调试。
两个流完全独立:主进程只需读 stdout,不会被装饰文本干扰。
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
5. 修改后,用 run_command 运行测试验证;测试失败则分析错误并继续修改,不要原样重试

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
# 事件类型:turn_start / thinking / tool_call / tool_result / final / stopped / error

# ANSI 颜色码(Windows 10+ 终端支持)
_C_RESET = "\033[0m"
_C_DIM = "\033[2m"
_C_CYAN = "\033[36m"
_C_YELLOW = "\033[33m"
_C_GREEN = "\033[32m"
_C_RED = "\033[31m"
_C_BLUE = "\033[34m"


def _pretty(event: dict) -> str:
    """把结构化事件转成人类可读的彩色控制台文本(写到 stderr)。"""
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
    return ""


def emit(event: dict) -> None:
    """发出一个结构化事件。

    - stdout: 紧凑 JSON(单行),供主进程逐行解析转发给渲染进程。
    - stderr: 人类可读彩色文本,供直接终端调试时看。
    两个流独立,互不污染。
    """
    event = {"ts": time.time(), **event}
    # stdout: 机器可读 JSONL(供 Electron 主进程解析)
    print(json.dumps(event, ensure_ascii=False), flush=True)
    # stderr: 人类可读彩色文本(flush 保证实时)
    line = _pretty(event)
    if line:
        print(line, file=sys.stderr, flush=True)


def _pick_content(msg) -> str:
    """提取模型的思考内容。

    deepseek-chat 的"思考"就是伴随工具调用产生的 msg.content;
    deepseek-reasoner 才有独立的 reasoning_content(但它不支持 function calling)。
    两者都做兼容,优先 reasoning_content,其次 content。
    """
    reasoning = getattr(msg, "reasoning_content", None)
    if reasoning:
        return reasoning
    return (msg.content or "").strip()


# ---------------------------------------------------------------------------
# Agent 主循环
# ---------------------------------------------------------------------------


def run_agent(user_input: str, max_turns: int = MAX_TURNS) -> str | None:
    messages = [
        {"role": "system", "content": _build_system_prompt()},
        {"role": "user", "content": user_input},
    ]

    for turn in range(1, max_turns + 1):
        emit({"type": "turn_start", "turn": turn})
        try:
            response = client.chat.completions.create(
                model=MODEL,
                messages=messages,
                tools=TOOLS,
            )
        except Exception as e:
            emit({"type": "error", "turn": turn, "message": str(e)})
            raise

        msg = response.choices[0].message
        messages.append(msg)

        # 打印思考内容(deepseek-chat 的工具调用常附带一段解释,以前被丢弃了)
        thinking = _pick_content(msg)
        if thinking:
            emit({"type": "thinking", "turn": turn, "content": thinking})

        # 没有工具调用 → 模型给出最终回答,结束
        if not msg.tool_calls:
            emit({"type": "final", "turn": turn, "content": thinking or "(无文字回复)"})
            return msg.content

        # 有工具调用 → 逐个执行,把结果回传给模型
        for tool_call in msg.tool_calls:
            func_name = tool_call.function.name
            raw_args = tool_call.function.arguments
            emit({"type": "tool_call", "turn": turn, "id": tool_call.id,
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

            emit({"type": "tool_result", "turn": turn, "id": tool_call.id,
                  "name": func_name, "result": result})

            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tool_call.id,
                    "content": result,
                }
            )

    emit({"type": "stopped", "turn": max_turns})
    return None
