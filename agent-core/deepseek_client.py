"""DeepSeek API 客户端(OpenAI 兼容接口)。

懒加载:导入本模块不需要 API key,只有真正发起请求时才校验,
便于在无 key 环境(如单元测试、CI)中导入其它模块。
"""
import os

from openai import OpenAI

_client: OpenAI | None = None


def _raise_missing_key() -> None:
    raise SystemExit(
        "[配置错误] 请先设置环境变量 QINIU_API_KEY(或 DEEPSEEK_API_KEY):\n"
        "  PowerShell: $env:QINIU_API_KEY='你的key'\n"
        "  CMD:       set QINIU_API_KEY=你的key\n"
        "  Linux/Mac:  export QINIU_API_KEY=你的key\n"
        "\n可选环境变量:\n"
        "  QINIU_BASE_URL  默认 https://api.qnaigc.com/v1\n"
        "  QINIU_MODEL     默认 qiniu/conatus-free"
    )


def get_client() -> OpenAI:
    """获取(首次调用时创建)OpenAI 兼容客户端。"""
    global _client
    if _client is None:
        api_key = os.environ.get("QINIU_API_KEY") or os.environ.get("DEEPSEEK_API_KEY")
        if not api_key:
            _raise_missing_key()
        base_url = os.environ.get("QINIU_BASE_URL", "https://api.qnaigc.com/v1")
        _client = OpenAI(api_key=api_key, base_url=base_url)
    return _client


# 向后兼容:agent_loop 里目前用 `from deepseek_client import client`
# 改为用 get_client()。保留下面的 client 属性访问以减少破坏性改动。
class _ClientProxy:
    def __getattr__(self, name):
        return getattr(get_client(), name)


client = _ClientProxy()
