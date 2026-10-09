"""DeepSeek API 客户端(OpenAI 兼容接口)。

懒加载:导入本模块不需要 API key,只有真正发起请求时才校验,
便于在无 key 环境(如单元测试、CI)中导入其它模块。
"""
import os

from openai import OpenAI

_client: OpenAI | None = None


def _raise_missing_key() -> None:
    raise SystemExit(
        "[配置错误] 请先设置环境变量 DEEPSEEK_API_KEY:\n"
        "  PowerShell: $env:DEEPSEEK_API_KEY='sk-你的key'\n"
        "  CMD:       set DEEPSEEK_API_KEY=sk-你的key\n"
        "  Linux/Mac:   export DEEPSEEK_API_KEY=sk-你的key"
    )


def get_client() -> OpenAI:
    """获取(首次调用时创建)OpenAI 兼容客户端。"""
    global _client
    if _client is None:
        api_key = os.environ.get("DEEPSEEK_API_KEY")
        if not api_key:
            _raise_missing_key()
        _client = OpenAI(api_key=api_key, base_url="https://api.deepseek.com")
    return _client


# 向后兼容:agent_loop 里目前用 `from deepseek_client import client`
# 改为用 get_client()。保留下面的 client 属性访问以减少破坏性改动。
class _ClientProxy:
    def __getattr__(self, name):
        return getattr(get_client(), name)


client = _ClientProxy()
