# agent-core

DeepSeek / 七牛 驱动的最小可用 CLI Agent：读文件 → 改文件 → 跑命令的自动循环。
纯 Python，前端无关（JSONL over stdin/stdout），可被任何宿主进程或 IDE 复用。

## 目录

| 文件 | 作用 |
|---|---|
| `main.py` | CLI 入口，stdout=JSONL 事件流，stderr=彩色日志 |
| `agent_loop.py` | 主循环：流式 / 审批 / 压缩 / 模型 fallback |
| `executor.py` | 15 个工具实现 + `TOOL_MAP` 注册 |
| `tools.py` | 工具 JSON Schema |
| `deepseek_client.py` | OpenAI 兼容客户端（懒加载，import 不需要 key） |
| `repo_map.py` | 工作区骨架生成，注入 system prompt |

## 安装

```bat
pip install -r requirements.txt
```

唯一外部依赖是 `openai`。其余全是标准库。

## 运行

```bat
set QINIU_API_KEY=sk-你的key
set AGENT_WORKSPACE=E:\你的目标工程
cd /d E:\你的目标工程
python <agent-core路径>\main.py --interactive
```

交互模式从 stdin 逐行读 JSON 指令，stdout 输出 JSONL 事件：

```
{"type":"send","content":"你的任务","mode":"act"}
{"type":"exit"}
```

单次模式：`python main.py "任务描述"`。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `QINIU_API_KEY` 或 `DEEPSEEK_API_KEY` | 必填 | API Key，二选一 |
| `QINIU_BASE_URL` | `https://api.qnaigc.com/v1` | API 端点；用 DeepSeek 官方时设 `https://api.deepseek.com/v1` |
| `AGENT_MODEL_LIST` | `qiniu/conatus-free,nvidia/nemotron-3-ultra-550b-a55b0-free` | 模型 fallback 列表，逗号分隔 |
| `AGENT_MODEL_COOLDOWN` | `60` | 模型失败冷却秒数 |
| `AGENT_WORKSPACE` | 当前目录 | 路径围栏根目录 |
| `AGENT_TIMEOUT` | `120` | 单条命令超时（秒） |
| `AGENT_MAX_TURNS` | `50` | 最大循环轮次 |
| `AGENT_MAX_RETRIES` | `4` | 最大重试次数 |
| `AGENT_CONTEXT_BUDGET` | `64000` | 上下文字符预算 |

## 工具（15 个）

| 工具 | 说明 |
|---|---|
| `read_file` / `write_file` / `edit_file` | 读写改，`edit_file` 三级匹配 |
| `list_dir` / `find_files` / `search_code` | 目录 / 找文件 / 搜内容 |
| `run_command` / `run_script` | 单行命令 / 多行脚本（写临时文件） |
| `memory` | 项目经验库，按 title 合并 |
| `attempt_completion` | 模型显式声明完成 |
| `ask_followup_question` | 模型主动提问，等待用户回答 |
| `list_symbols` / `read_symbol` / `patch_symbol` | 符号级读写改（`ast` 定位） |
| `restart_self` | 触发 Easycode 主进程重启（**非 Easycode 项目不适用**） |

## 行为说明

- 文件按 utf-8 优先、GBK 兜底读取；修改时按原编码写回，生成 `<文件名>.bak`。
- 危险命令（`rm -rf`、`format` 等）被拦截。
- 路径围栏：只能读写工作区内的文件。
- `patch_symbol` 写入前做整文件 `ast.parse` 校验，语法错不写。
- 写文件类工具（`write_file` / `edit_file` / `patch_symbol`）在交互模式下走审批；单次模式不走。

## 独立成项目注意

- `restart_self` 硬编码检查 Easycode 的 `package.json`，独立使用可忽略。
- `run_command` 依赖系统 PATH 的 git / npm / python，运行 TS 项目需装 node。
- 与 Easycode 的 `agent-core` 需保持字节一致（见上层 `sync_easycode.py`）。
