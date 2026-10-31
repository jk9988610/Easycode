"""executor.py 核心函数单测。

覆盖：
- safe_path: 工作区围栏（安全核心）
- _normalize_newlines: CRLF/LF 归一化（已知 bug 区）
- _snippet: 带行号片段
- edit_file: L1 精确匹配 + L2 空白归一化 + dry_run + 未找到

L3 块锚点与 CRLF 写回断言待补（等写回逻辑确认）。
"""
import os

import pytest

import executor


# ---------------- safe_path ----------------

class TestSafePath:
    def test_inside_relative(self, ws):
        p = executor.safe_path("a.txt")
        assert os.path.isabs(p)
        assert p.lower().startswith(str(ws).lower())

    def test_inside_subdir(self, ws):
        p = executor.safe_path("sub/a.txt")
        assert p.lower().startswith(str(ws).lower())

    def test_escape_dotdot(self, ws):
        with pytest.raises(PermissionError):
            executor.safe_path("../outside.txt")

    def test_escape_nested(self, ws):
        with pytest.raises(PermissionError):
            executor.safe_path("sub/../../outside.txt")

    def test_absolute_inside(self, ws):
        target = str(ws / "x.txt")
        assert executor.safe_path(target) == target

    def test_absolute_outside(self, ws):
        with pytest.raises(PermissionError):
            executor.safe_path(str(ws.parent / "outside.txt"))


# ---------------- _normalize_newlines ----------------

class TestNormalizeNewlines:
    def test_lf_stays_lf(self):
        assert executor._normalize_newlines("a\nb", False) == "a\nb"

    def test_crlf_to_lf(self):
        assert executor._normalize_newlines("a\r\nb", False) == "a\nb"

    def test_cr_to_lf(self):
        assert executor._normalize_newlines("a\rb", False) == "a\nb"

    def test_lf_to_crlf(self):
        assert executor._normalize_newlines("a\nb", True) == "a\r\nb"

    def test_crlf_idempotent(self):
        assert executor._normalize_newlines("a\r\nb", True) == "a\r\nb"

    def test_mixed_to_crlf(self):
        assert executor._normalize_newlines("a\rb\nc\r\nd", True) == "a\r\nb\r\nc\r\nd"


# ---------------- _snippet ----------------

class TestSnippet:
    def test_basic(self):
        s = executor._snippet("l1\nl2\nl3", 2, 3)
        assert "    2 | l2" in s
        assert "    3 | l3" in s
        assert "l1" not in s

    def test_endpoints_included(self):
        s = executor._snippet("a\nb\nc", 1, 3)
        for line in ("a", "b", "c"):
            assert line in s

    def test_start_clamped_to_one(self):
        s = executor._snippet("a\nb", 0, 1)
        assert "    1 | a" in s

    def test_end_clamped(self):
        s = executor._snippet("a\nb", 1, 999)
        assert "a" in s and "b" in s


# ---------------- edit_file: L1 精确匹配 ----------------

class TestEditFileExact:
    def test_replaces_content(self, ws):
        f = ws / "x.py"
        f.write_text("line1\nline2\nline3\n", encoding="utf-8")
        executor.edit_file("x.py", "line2", "LINE2")
        assert "LINE2" in f.read_text(encoding="utf-8")

    def test_dry_run_does_not_write(self, ws):
        f = ws / "x.txt"
        f.write_text("hello\nworld\n", encoding="utf-8")
        before = f.read_text(encoding="utf-8")
        executor.edit_file("x.txt", "hello", "bye", dry_run=True)
        assert f.read_text(encoding="utf-8") == before

    def test_not_found_does_not_raise(self, ws):
        f = ws / "x.txt"
        f.write_text("alpha\nbeta\n", encoding="utf-8")
        r = executor.edit_file("x.txt", "nonexistent_xyz", "x")
        assert isinstance(r, str)
        assert f.read_text(encoding="utf-8") == "alpha\nbeta\n"


# ---------------- edit_file: L2 空白归一化 ----------------

class TestEditFileWhitespaceNormalized:
    def test_trailing_whitespace_tolerated(self, ws):
        """old 行尾无空格，文件行尾有空格 → rstrip 后逐行匹配成功。"""
        f = ws / "x.py"
        f.write_text("def foo():   \n    return 1\n", encoding="utf-8")
        executor.edit_file(
            "x.py",
            "def foo():\n    return 1",
            "def bar():\n    return 2",
        )
        c = f.read_text(encoding="utf-8")
        assert "def bar()" in c
        assert "return 2" in c
