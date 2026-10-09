"""CLI 入口。

用法:
  交互/调试(带彩色 stderr): python main.py "任务描述"
  集成模式(纯 stdout JSONL): 主进程 spawn 时带 --json 参数即可(默认就是 JSONL)

输出契约:
  - stdout: 每行一个 JSON 事件(JSONL),GUI 集成时只需逐行读 stdout。
  - stderr: 人类可读的彩色文本,直接跑 CLI 时看这个流。
"""
import sys

from agent_loop import run_agent


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        print(
            '示例: python main.py "给 utils.py 的 add 函数加上类型检查,然后运行测试验证"',
            file=sys.stderr,
        )
        sys.exit(1)
    task = " ".join(sys.argv[1:])
    # 任务提示只写到 stderr,保持 stdout 纯 JSONL
    print(f"📝 任务: {task}", file=sys.stderr, flush=True)
    run_agent(task)


if __name__ == "__main__":
    main()
