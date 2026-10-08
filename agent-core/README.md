# agent-core

DeepSeek 驱动的最小可用 CLI Agent:读文件 → 改文件 → 跑命令的自动循环。

## 为什么放在 Easycode 仓库里

- 本目录是**工具代码**,与被修改的**目标工程**分离。
- Agent 的工作区围栏以「启动时的当前目录」为准,所以 agent-core 不应放进
  它要操作的目标工程——否则 `.bak` 备份会污染目标工程的版本库,agent 也能改到自己。
- Easycode 的构建(esbuild / tsc / vite)只包含 `src/` 与显式入口,
  根目录下的 Python 文件夹与构建零交集,不会互相干扰。

## 使用

```bat
pip install -r E:\tools\Easycode\agent-core\requirements.txt
set DEEPSEEK_API_KEY=sk-你的key

cd /d e:\你的目标工程
python E:\tools\Easycode\agent-core\main.py "给 utils.py 的 add 函数加上类型检查,然后运行测试验证"
```

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 必填 | DeepSeek API Key |
| `DEEPSEEK_MODEL` | `deepseek-chat` | 模型名,可改为 `deepseek-reasoner` 等 |
| `AGENT_WORKSPACE` | 当前目录 | Agent 的路径围栏根目录 |
| `AGENT_TIMEOUT` | `30` | 单条命令超时(秒) |
| `AGENT_MAX_TURNS` | `15` | 最大循环轮次 |

## 行为说明

- 文件按 utf-8 优先、GBK 兜底读取;修改时按原编码写回,并生成 `<文件名>.bak` 备份。
- 危险命令(`rm -rf`、`format` 等)会被拦截。
- 路径围栏:只能读写工作区内的文件。
- 后续接入 Electron:把 `agent_loop.py` 里的 `print` 换成 IPC 事件发送即可。
