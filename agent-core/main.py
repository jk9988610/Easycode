"""CLI 入口。

用法:先 cd 到目标工程目录,再运行本脚本(Agent 的围栏 = 启动时的当前目录):

    cd /d e:\\你的目标工程
    python E:\\tools\\Easycode\\agent-core\\main.py "任务描述"
"""
import sys

from agent_loop import run_agent


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        print('示例: python main.py "给 utils.py 的 add 函数加上类型检查,然后运行测试验证"')
        sys.exit(1)
    task = " ".join(sys.argv[1:])
    print(f"📝 任务: {task}")
    run_agent(task)


if __name__ == "__main__":
    main()
