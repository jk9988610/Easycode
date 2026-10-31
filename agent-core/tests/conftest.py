import sys
from pathlib import Path

import pytest

# 让 `import executor` 找到 agent-core/
_AC = Path(__file__).resolve().parent.parent
if str(_AC) not in sys.path:
    sys.path.insert(0, str(_AC))

import executor  # noqa: E402


@pytest.fixture
def ws(tmp_path, monkeypatch):
    """把 executor.WORKSPACE 指向临时目录，隔离文件系统。"""
    monkeypatch.setattr(executor, "WORKSPACE", str(tmp_path))
    return tmp_path
