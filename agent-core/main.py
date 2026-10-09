"""CLI 入口。

两种模式:
  单次模式(默认):  python main.py "任务描述"
  交互模式(长对话): python main.py --interactive

输出契约:
  - stdout: 每行一个 JSON 事件(JSONL),GUI 集成时只需逐行读 stdout。
  - stderr: 人类可读的彩色文本,直接跑 CLI 时看这个流。
"""
import sys

from agent_loop import run_agent, run_interactive


def main() -> None:
    if "--interactive" in sys.argv:
        print("🟢 启动交互模式(stdin 发送 JSON 指令)", file=sys.stderr, flush=True)
        run_interactive()
        return

    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        print(
            '示例: python main.py "给 utils.py 的 add 函数加上类型检查,然后运行测试验证"',
            file=sys.stderr,
        )
        sys.exit(1)

    task = " ".join(a for a in sys.argv[1:] if not a.startswith("-"))
    if not task:
        print("错误:缺少任务描述", file=sys.stderr)
        sys.exit(1)
    print(f"📝 任务: {task}", file=sys.stderr, flush=True)
    run_agent(task)


if __name__ == "__main__":
    main()
