要让 AI 完成“第 1 步：CLI Agent Core”，核心是构建一个能自动循环的管道：**你输入指令 → DeepSeek 决定调用工具 → 你的程序执行工具 → 结果回传 DeepSeek → 循环直到任务完成**。下面是从零实现的完整步骤。

---

## 📦 先装依赖

```bash
pip install openai
```

DeepSeek API 完全兼容 OpenAI SDK，只需把 `base_url` 指向 DeepSeek。

```python
# deepseek_client.py
import os
from openai import OpenAI

client = OpenAI(
    api_key=os.environ["DEEPSEEK_API_KEY"],
    base_url="https://api.deepseek.com"
)
```


## 🔧 定义三个核心工具

你需要用 JSON Schema 告诉 DeepSeek 有哪些工具可用、参数是什么。

```python
# tools.py
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "读取指定文件的全部内容。修改文件前必须先读取。",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "文件的绝对或相对路径"
                    }
                },
                "required": ["path"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "edit_file",
            "description": "将文件中指定的旧文本精确替换为新文本。用于修改代码。",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "文件路径"
                    },
                    "old_text": {
                        "type": "string",
                        "description": "要被替换的原文本，必须与文件内容完全一致"
                    },
                    "new_text": {
                        "type": "string",
                        "description": "替换后的新文本"
                    }
                },
                "required": ["path", "old_text", "new_text"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "run_command",
            "description": "在工作目录下执行 shell 命令，用于运行测试、格式化、Git 操作等。",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "要执行的命令，如 pytest tests/"
                    }
                },
                "required": ["command"]
            }
        }
    }
]
```

关键点：`description` 写得越清楚，模型越不容易调错。


## ⚙️ 实现工具执行器

模型只负责“说要调用什么”，真正执行的是你的代码。

```python
# executor.py
import os
import subprocess

WORKSPACE = os.path.abspath(".")

def safe_path(path: str) -> str:
    """路径围栏：禁止访问工作区外的文件"""
    full = os.path.abspath(os.path.join(WORKSPACE, path))
    if not full.startswith(WORKSPACE):
        raise PermissionError(f"禁止访问工作区外路径: {path}")
    return full

def read_file(path: str) -> str:
    try:
        with open(safe_path(path), "r", encoding="utf-8") as f:
            return f.read()
    except Exception as e:
        return f"[错误] 读取失败: {e}"

def edit_file(path: str, old_text: str, new_text: str) -> str:
    try:
        full = safe_path(path)
        with open(full, "r", encoding="utf-8") as f:
            content = f.read()

        if old_text not in content:
            return "[错误] 未在文件中找到要替换的文本，请先 read_file 确认内容"

        # 写前备份
        backup = full + ".bak"
        with open(backup, "w", encoding="utf-8") as f:
            f.write(content)

        content = content.replace(old_text, new_text, 1)
        with open(full, "w", encoding="utf-8") as f:
            f.write(content)
        return f"[成功] 已修改 {path}（备份: {backup}）"
    except Exception as e:
        return f"[错误] 修改失败: {e}"

def run_command(command: str) -> str:
    # 简单危险命令拦截
    DANGEROUS = ["rm -rf", "del /f", "format", "shutdown", "git reset --hard"]
    if any(d in command.lower() for d in DANGEROUS):
        return "[拒绝] 危险命令已拦截，请手动执行"

    try:
        result = subprocess.run(
            command,
            shell=True,
            cwd=WORKSPACE,
            capture_output=True,
            text=True,
            timeout=30
        )
        output = result.stdout + result.stderr
        return output[:5000] if output else "[成功] 命令执行完毕，无输出"
    except subprocess.TimeoutExpired:
        return "[错误] 命令执行超时（30秒）"
    except Exception as e:
        return f"[错误] 命令执行失败: {e}"

TOOL_MAP = {
    "read_file": read_file,
    "edit_file": edit_file,
    "run_command": run_command,
}
```


## 🔄 构建 Agent 循环（最关键）

这就是 Agent 的心脏。参考 DeepSeek 官方示例和实战教程，核心逻辑约 30 行。

```python
# agent_loop.py
import json
from deepseek_client import client
from tools import TOOLS
from executor import TOOL_MAP

SYSTEM_PROMPT = """你是一个代码修改助手，工作在当前项目目录下。

工作流程：
1. 修改代码前，先用 read_file 读取文件了解现状
2. 用 edit_file 精确替换代码
3. 修改后，用 run_command 运行测试验证
4. 如果测试失败，分析错误并继续修改

规则：
- 只做用户要求的事情，不要擅自修改无关文件
- 每次 edit_file 的 old_text 必须与文件内容完全一致
- 如果命令执行失败，先分析原因再行动
"""

def run_agent(user_input: str, max_turns: int = 15):
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_input}
    ]

    for turn in range(max_turns):
        print(f"\n--- 第 {turn + 1} 轮 ---")

        response = client.chat.completions.create(
            model="deepseek-flash",
            messages=messages,
            tools=TOOLS
        )

        msg = response.choices[0].message
        messages.append(msg)

        # 没有工具调用 → 模型给出最终回答，结束
        if not msg.tool_calls:
            print(f"\n✅ 助手: {msg.content}")
            return msg.content

        # 有工具调用 → 逐个执行
        for tool_call in msg.tool_calls:
            func_name = tool_call.function.name
            func_args = json.loads(tool_call.function.arguments)

            print(f"  🔧 调用: {func_name}({func_args})")

            # 校验工具名
            if func_name not in TOOL_MAP:
                result = f"[错误] 未知工具: {func_name}"
            else:
                result = TOOL_MAP[func_name](**func_args)

            print(f"  📄 结果: {result[:200]}...")

            # 把结果回传给模型
            messages.append({
                "role": "tool",
                "tool_call_id": tool_call.id,
                "content": result
            })

    print("\n⚠️ 达到最大轮次，已停止")
    return None
```


## 🖥️ 加 CLI 入口

```python
# main.py
import sys
from agent_loop import run_agent

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法: python main.py \"你的任务描述\"")
        print("示例: python main.py \"给 utils.py 里的 add 函数加上异常处理，然后跑测试\"")
        sys.exit(1)

    task = " ".join(sys.argv[1:])
    print(f"📝 任务: {task}")
    run_agent(task)
```


## 🧪 测试闭环

假设你有这样一个项目：

```text
my_project/
  utils.py
  test_utils.py
```

`utils.py`：
```python
def add(a, b):
    return a + b
```

`test_utils.py`：
```python
from utils import add

def test_add():
    assert add(1, 2) == 3
    assert add(-1, 1) == 0
```

运行：

```bash
cd my_project
export DEEPSEEK_API_KEY="sk-你的key"
python ../agent-core/main.py "给 add 函数加上类型检查，如果参数不是数字就抛出 TypeError，然后运行测试验证"
```

预期 Agent 行为：

```text
--- 第 1 轮 ---
  🔧 调用: read_file({"path": "utils.py"})
  📄 结果: def add(a, b):\n    return a + b

--- 第 2 轮 ---
  🔧 调用: edit_file({"path": "utils.py", "old_text": "def add(a, b):\n    return a + b", "new_text": "def add(a, b):\n    if not isinstance(a, (int, float)) or not isinstance(b, (int, float)):\n        raise TypeError(\"参数必须是数字\")\n    return a + b"})
  📄 结果: [成功] 已修改 utils.py（备份: utils.py.bak）

--- 第 3 轮 ---
  🔧 调用: run_command({"command": "pytest test_utils.py -v"})
  📄 结果: ... 2 passed ...

--- 第 4 轮 ---
✅ 助手: 已完成。给 add 函数加上了类型检查，测试全部通过。
```

这就是完整的“读文件 → 改文件 → 跑测试”闭环。


## ⚠️ 常见问题

| 问题 | 原因 | 解决 |
|---|---|---|
| 模型不调用工具，直接回答 | 系统提示不够明确 | 在 `SYSTEM_PROMPT` 里强调“必须先读文件再修改” |
| `old_text` 匹配失败 | 模型凭记忆写 old_text | 强化提示：“old_text 必须与 read_file 返回的内容完全一致” |
| 命令超时 | 测试跑太久 | 设 `timeout=30`，提示模型“测试超时请检查是否有死循环” |
| 无限循环 | 模型反复调用同一工具 | 设 `max_turns=15`，加轮次限制 |
| API 报错 | Key 或网络问题 | 检查 `DEEPSEEK_API_KEY` 环境变量 |


## 📁 最终文件结构

```text
agent-core/
  deepseek_client.py   # API 客户端
  tools.py             # 工具 JSON Schema 定义
  executor.py          # 工具实际执行逻辑
  agent_loop.py        # Agent 循环
  main.py              # CLI 入口
```

跑通后，这个 Core 可以直接被 Electron 主进程调用，把 `print` 换成 IPC 事件发送即可。先让它在命令行里稳定工作，再考虑接 UI。
这个agent-core文件目录在哪里放置,可以放在当前工作区吗.