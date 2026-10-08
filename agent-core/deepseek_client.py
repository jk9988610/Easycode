"""DeepSeek API 客户端(OpenAI 兼容接口)。"""
import os

from openai import OpenAI

_api_key = os.environ.get("DEEPSEEK_API_KEY")
if not _api_key:
    raise SystemExit(
        "[配置错误] 请先设置环境变量 DEEPSEEK_API_KEY:\n"
        "  PowerShell: $env:DEEPSEEK_API_KEY='sk-你的key'\n"
        "  CMD:       set DEEPSEEK_API_KEY=sk-你的key\n"
        "  Linux/Mac:   export DEEPSEEK_API_KEY=sk-你的key"
    )

client = OpenAI(
    api_key=_api_key,
    base_url="https://api.deepseek.com",
)
