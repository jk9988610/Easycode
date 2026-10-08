"""Agent 循环(核心):指令 → 模型决定调工具 → 执行 → 结果回传 → 直到完成。"""
import json
import os
import platform

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


def run_agent(user_input: str, max_turns: int = MAX_TURNS):
    messages = [
        {"role": "system", "content": _build_system_prompt()},
        {"role": "user", "content": user_input},
    ]

    for turn in range(max_turns):
        print(f"\n--- 第 {turn + 1} 轮 ---")
        response = client.chat.completions.create(
            model=MODEL,
            messages=messages,
            tools=TOOLS,
        )
        msg = response.choices[0].message
        messages.append(msg)

        # 没有工具调用 → 模型给出最终回答,结束
        if not msg.tool_calls:
            print(f"\n✅ 助手: {msg.content}")
            return msg.content

        # 有工具调用 → 逐个执行,把结果回传给模型
        for tool_call in msg.tool_calls:
            func_name = tool_call.function.name
            print(f"  🔧 调用: {func_name}({tool_call.function.arguments})")
            try:
                func_args = json.loads(tool_call.function.arguments or "{}")
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
            print(f"  📄 结果: {result[:200]}")
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tool_call.id,
                    "content": result,
                }
            )

    print("\n⚠️ 达到最大轮次,已停止")
    return None
