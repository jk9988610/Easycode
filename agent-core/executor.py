"""工具执行器:模型只负责"说要调用什么",真正执行的是这里。"""
import ast
import json
import os
import py_compile


import secrets
import shutil
import string
import subprocess
import tempfile
import uuid
from datetime import datetime

# 工作区围栏:默认为启动时的当前目录;可用环境变量 AGENT_WORKSPACE 覆盖
WORKSPACE = os.path.abspath(os.environ.get("AGENT_WORKSPACE") or os.getcwd())

# 单条命令超时时间(秒),可用 AGENT_TIMEOUT 覆盖
TIMEOUT = int(os.environ.get("AGENT_TIMEOUT", "120"))

DANGEROUS = [
    "rm -rf",
    "del /f",
    "rmdir /s",
    "rd /s",
    "format",
    "shutdown",
    "diskpart",
    "reg delete",
    "git reset --hard",
    "git push --force",
]


def safe_path(path: str) -> str:
    """路径围栏:禁止访问工作区外的文件。"""
    full = os.path.abspath(os.path.join(WORKSPACE, path))
    root, target = WORKSPACE, full
    if os.name == "nt":  # Windows 路径不区分大小写
        root, target = root.lower(), target.lower()
    if target != root and not target.startswith(root + os.sep):
        raise PermissionError(f"禁止访问工作区外路径: {path}")
    return full


def _read_text(full: str) -> tuple[str, str]:
    """utf-8 优先、GBK 兜底地读取文本,返回 (内容, 编码)。

    newline="" 保留文件原始换行符(LF/CRLF 不被转换),
    避免 LF 文件重写后变 CRLF 产生无意义 diff。
    """
    try:
        with open(full, "r", encoding="utf-8", newline="") as f:
            return f.read(), "utf-8"
    except UnicodeDecodeError:
        with open(full, "r", encoding="gbk", errors="replace", newline="") as f:
            return f.read(), "gbk"


def _backup(full: str) -> str:
    """二进制级备份(不经文本编解码,任何文件都安全)。"""
    backup = full + ".bak"
    shutil.copyfile(full, backup)
    return backup


def _check_py_syntax(full: str) -> str:
    """对 .py 文件做 py_compile 校验。返回空串=OK，非空=错误摘要首行。非 .py 一律返回空。"""
    if not full.lower().endswith(".py"):
        return ""
    try:
        py_compile.compile(full, doraise=True)
        return ""
    except py_compile.PyCompileError as e:
        first = str(e).splitlines()[0] if str(e) else "语法错误"
        return first[:200]
    except Exception:
        return ""


def read_file(path: str, start: int = None, end: int = None) -> str:

    """读取文件内容。start/end 为 1-based 行号(含),省略则读全文。

    大文件推荐带 start/end,避免一次性灌满上下文。
    """
    try:
        content, _ = _read_text(safe_path(path))
        if start is None and end is None:
            return content
        lines = content.split("\n")
        total = len(lines)
        s = (start - 1) if start else 0
        e = end if end else total
        s = max(0, s)
        e = min(e, total)
        out = []
        for i in range(s, e):
            out.append("%5d | %s" % (i + 1, lines[i]))
        out.append("(共 %d 行,显示 %d-%d)" % (total, s + 1, e))
        return "\n".join(out)
    except Exception as e:
        return f"[错误] 读取失败: {e}"


def write_file(path: str, content: str, encoding: str = "utf-8") -> str:
    """创建或整体覆写文件。

    已存在的文件自动沿用原编码(防止把 GBK 工程写成 UTF-8)并生成 .bak 备份;
    新建文件用 encoding 参数(默认 utf-8)。
    """
    try:
        full = safe_path(path)
        existed = os.path.exists(full)
        if existed:
            _, enc = _read_text(full)  # 沿用原编码
            _backup(full)
        else:
            enc = encoding
        try:
            with open(full, "w", encoding=enc, newline="") as f:
                f.write(content)
        except UnicodeEncodeError:
            return (
                f"[错误] 内容无法用 {enc} 编码写入。"
                "若目标文件是 GBK 编码,请去掉内容中的非中文字符(如 emoji、特殊符号),"
                "或确认是否应为 utf-8 文件"
            )
        note = f",备份: {full}.bak" if existed else ""
        syntax = _check_py_syntax(full)
        if syntax:
            return f"[成功但语法错误] 已写入 {path}(编码: {enc}{note})，编译失败: {syntax}"
        return f"[成功] 已写入 {path}(编码: {enc}{note})"

    except Exception as e:
        return f"[错误] 写入失败: {e}"


def _normalize_newlines(text: str, use_crlf: bool) -> str:
    """把 text 中所有换行统一成 use_crlf 指定的风格,便于跨换行风格匹配/写入。"""
    unified = text.replace("\r\n", "\n").replace("\r", "\n")
    if use_crlf:
        return unified.replace("\n", "\r\n")
    return unified


def _snippet(content: str, start_line: int, end_line: int) -> str:
    """返回带行号的片段(1-based,含端点)。"""
    lines = content.split("\n")
    s = max(0, start_line - 1)
    e = min(len(lines), end_line)
    out = []
    for i in range(s, e):
        out.append("%5d | %s" % (i + 1, lines[i]))
    return "\n".join(out)


def edit_file(path: str, old_text: str, new_text: str, dry_run: bool = False):
    """将文件中指定的旧文本替换为新文本。

    多级匹配链:精确 → 空白归一化(每行 rstrip) → 块锚点(首尾各最多 3 个非空行)。
    全失败时返回当前文件相关片段,便于模型零往返修正 old_text。
    """
    try:
        full = safe_path(path)
        content, enc = _read_text(full)
        use_crlf = "\r\n" in content

        content_lf = content.replace("\r\n", "\n")
        old_lf = old_text.replace("\r\n", "\n")
        new_lf = new_text.replace("\r\n", "\n")

        result_lf = None
        matched_level = None

        # L1: 精确匹配
        if old_lf in content_lf:
            result_lf = content_lf.replace(old_lf, new_lf, 1)
            matched_level = "精确匹配"
        else:
            content_lines = content_lf.split("\n")
            old_lines = old_lf.split("\n")

            # L2: 空白归一化(每行 rstrip 后逐行比较)
            old_norm = [l.rstrip() for l in old_lines]
            content_norm = [l.rstrip() for l in content_lines]
            n = len(old_norm)
            if n > 0:
                for i in range(len(content_norm) - n + 1):
                    if content_norm[i:i + n] == old_norm:
                        new_block = new_lf.split("\n")
                        new_lines = content_lines[:i] + new_block + content_lines[i + n:]
                        result_lf = "\n".join(new_lines)
                        matched_level = "空白归一化匹配"
                        break

            # L3: 块锚点(首尾各最多 3 个非空行,中间通配)
            if result_lf is None:
                old_nonempty = [l for l in old_lines if l.strip()]
                if len(old_nonempty) >= 2:
                    head = old_nonempty[:3]
                    tail = old_nonempty[-3:]
                    found = False
                    for i in range(len(content_lines) - len(head) + 1):
                        if all(content_lines[i + k].rstrip() == head[k].rstrip()
                               for k in range(len(head))):
                            for j in range(i + len(head),
                                           len(content_lines) - len(tail) + 1):
                                if all(content_lines[j + k].rstrip() == tail[k].rstrip()
                                       for k in range(len(tail))):
                                    end_idx = j + len(tail)
                                    new_block = new_lf.split("\n")
                                    new_lines = (content_lines[:i] + new_block
                                                 + content_lines[end_idx:])
                                    result_lf = "\n".join(new_lines)
                                    matched_level = "块锚点匹配"
                                    found = True
                                    break
                        if found:
                            break

        if result_lf is not None:
            if dry_run:
                import difflib as _dl
                new_content = _normalize_newlines(result_lf, use_crlf)
                diff = "".join(_dl.unified_diff(
                    content.splitlines(keepends=True),
                    new_content.splitlines(keepends=True),
                    fromfile=path + " (原)", tofile=path + " (新)"))
                return (diff or "(无变化)"), None
            _backup(full)
            result = _normalize_newlines(result_lf, use_crlf)
            with open(full, "w", encoding=enc, newline="") as f:
                f.write(result)
            syntax = _check_py_syntax(full)
            if syntax:
                return f"[成功但语法错误] 已修改 {path}(编码: {enc},{matched_level},备份: {full}.bak)，编译失败: {syntax}"
            return f"[成功] 已修改 {path}(编码: {enc},{matched_level},备份: {full}.bak)"


        # 全失败:返回诊断 + 当前文件片段
        import difflib
        content_lines = content_lf.split("\n")
        old_lines = old_lf.split("\n")
        first_old = old_lines[0].strip() if old_lines else ""
        close = difflib.get_close_matches(
            first_old, [l.strip() for l in content_lines], n=3, cutoff=0.4)
        hint = ""
        snippet_start = 1
        snippet_end = min(len(content_lines), 40)
        if close:
            hint = "\n最相似的行(供参考):\n" + "\n".join("  " + c for c in close)
            target = close[0]
            for idx, l in enumerate(content_lines):
                if l.strip() == target:
                    snippet_start = max(1, idx + 1 - 5)
                    snippet_end = min(len(content_lines), idx + 1 + 25)
                    break
        snippet = _snippet(content_lf, snippet_start, snippet_end)
        error_msg = (
            f"[错误] old_text 未在文件中找到(已尝试精确/空白归一化/块锚点匹配)。文件未修改。\n"
            f"old_text 首行: {first_old!r}{hint}\n\n"
            f"当前文件 {snippet_start}-{snippet_end} 行逐字内容如下,"
            f"请直接从下面复制 old_text(注意保留行首缩进):\n"
            f"--- current lines ---\n{snippet}\n--- end ---"
        )
        if dry_run:
            return None, error_msg
        return error_msg
    except Exception as e:
        if dry_run:
            return None, f"[错误] 修改失败: {e}"
        return f"[错误] 修改失败: {e}"


def _ast_parse_file(full: str):
    """解析 Python 文件为 ast。返回 (tree, src_lf, encoding, use_crlf)。
    tree 为 None 时 src_lf 是错误信息。"""
    content, enc = _read_text(full)
    use_crlf = "\r\n" in content
    src = content.replace("\r\n", "\n")
    try:
        return ast.parse(src), src, enc, use_crlf
    except SyntaxError as e:
        return None, "[错误] 不是合法 Python 文件: %s" % e, enc, use_crlf


def _iter_symbols(tree, prefix=""):
    """遍历顶层 def/class 和类内方法，yield (name, node)。不递归嵌套类。"""
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            yield (prefix + node.name, node)
        elif isinstance(node, ast.ClassDef):
            yield (prefix + node.name, node)
            for sub in node.body:
                if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    yield (prefix + node.name + "." + sub.name, sub)


def list_symbols(path: str) -> str:
    """列出 Python 文件的顶层函数/类和类内方法（含行号范围和签名）。
    不含装饰器行；嵌套类不展开。"""
    try:
        full = safe_path(path)
        tree, src, _, _ = _ast_parse_file(full)
        if tree is None:
            return src
        lines = src.split("\n")
        out = []
        for name, node in _iter_symbols(tree):
            start = node.lineno
            end = getattr(node, "end_lineno", start)
            kind = "class" if isinstance(node, ast.ClassDef) else "def"
            sig = lines[start - 1].strip()
            out.append("%4d-%-4d %-5s %-30s %s" % (start, end, kind, name, sig))
        if not out:
            return "(未找到函数或类)"
        return "(共 %d 个符号)\n" % len(out) + "\n".join(out)
    except Exception as e:
        return f"[错误] 列符号失败: {e}"


def read_symbol(path: str, name: str) -> str:
    """读取指定符号（函数/类/类方法）的完整源码，带行号。支持 Class.method 点号。
    不含装饰器行。"""
    try:
        full = safe_path(path)
        tree, src, _, _ = _ast_parse_file(full)
        if tree is None:
            return src
        for sym_name, node in _iter_symbols(tree):
            if sym_name == name:
                start = node.lineno
                end = getattr(node, "end_lineno", start)
                body = _snippet(src, start, end)
                return body + "\n(符号 %s,行 %d-%d)" % (name, start, end)
        available = [s for s, _ in _iter_symbols(tree)]
        return "[错误] 未找到符号 %r。可用符号: %s" % (
            name, ", ".join(available[:30]) or "(无)")
    except Exception as e:
        return f"[错误] 读符号失败: {e}"


def patch_symbol(path: str, name: str, new_body: str, dry_run: bool = False):
    """按符号名替换整个函数/类定义。new_body 缩进自动对齐到原符号。
    装饰器行不在替换范围内（ast lineno 不含 decorator_list）。
    写入前做整文件语法校验，失败不写。dry_run=True 返回 (diff, err)。"""
    try:
        full = safe_path(path)
        tree, src, enc, use_crlf = _ast_parse_file(full)
        if tree is None:
            return (None, src) if dry_run else src
        lines = src.split("\n")
        target = None
        for sym_name, node in _iter_symbols(tree):
            if sym_name == name:
                target = node
                break
        if target is None:
            available = [s for s, _ in _iter_symbols(tree)]
            msg = "[错误] 未找到符号 %r。可用符号: %s" % (
                name, ", ".join(available[:30]) or "(无)")
            return (None, msg) if dry_run else msg
        start = target.lineno
        end = getattr(target, "end_lineno", start)
        base_indent = target.col_offset
        new_lines = new_body.replace("\r\n", "\n").split("\n")
        while new_lines and not new_lines[-1].strip():
            new_lines.pop()
        nonempty = [l for l in new_lines if l.strip()]
        min_indent = min(len(l) - len(l.lstrip()) for l in nonempty) if nonempty else 0
        adjusted = []
        for l in new_lines:
            if not l.strip():
                adjusted.append("")
            else:
                adjusted.append(" " * base_indent + l[min_indent:])
        result = "\n".join(lines[:start - 1] + adjusted + lines[end:])
        try:
            ast.parse(result)
        except SyntaxError as e:
            msg = "[错误] new_body 导致语法错误，未写入: %s" % e
            return (None, msg) if dry_run else msg
        if dry_run:
            import difflib as _dl
            diff = "".join(_dl.unified_diff(
                src.splitlines(keepends=True),
                result.splitlines(keepends=True),
                fromfile=path + " (原)", tofile=path + " (新)"))
            return (diff or "(无变化)"), None
        _backup(full)
        out = result.replace("\n", "\r\n") if use_crlf else result
        with open(full, "w", encoding=enc, newline="") as f:
            f.write(out)
        msg = "[成功] 已替换 %s 的符号 %s(行 %d-%d,编码: %s,备份: %s.bak)" % (
            path, name, start, end, enc, full)
        syntax = _check_py_syntax(full)
        if syntax:
            msg = "[成功但语法错误] " + msg[len("[成功] "):] + "，编译失败: " + syntax
        return msg

    except Exception as e:
        msg = f"[错误] 替换符号失败: {e}"
        return (None, msg) if dry_run else msg


class _WhoUsesVisitor(ast.NodeVisitor):
    """收集对 symbol 的引用点。kind ∈ call/attr/name/import/def。"""

    def __init__(self, symbol, include_def):
        self.symbol = symbol
        self.include_def = include_def
        self.scope = []
        self.hits = []

    def _scope_str(self):
        return ".".join(self.scope) if self.scope else "<module>"

    def _record(self, lineno, kind):
        self.hits.append((lineno, kind, self._scope_str()))

    def _visit_def(self, node):
        if self.include_def and node.name == self.symbol:
            self._record(node.lineno, "def")
        self.scope.append(node.name)
        self.generic_visit(node)
        self.scope.pop()

    def visit_FunctionDef(self, node):
        self._visit_def(node)

    def visit_AsyncFunctionDef(self, node):
        self._visit_def(node)

    def visit_ClassDef(self, node):
        self._visit_def(node)

    def visit_Call(self, node):
        f = node.func
        matched = False
        if isinstance(f, ast.Name) and f.id == self.symbol:
            self._record(f.lineno, "call")
            matched = True
        elif isinstance(f, ast.Attribute) and f.attr == self.symbol:
            self._record(f.lineno, "call")
            matched = True
        for a in node.args:
            self.visit(a)
        for k in node.keywords:
            self.visit(k.value)
        if not matched:
            self.visit(f)

    def visit_Attribute(self, node):
        if node.attr == self.symbol:
            self._record(node.lineno, "attr")
        self.generic_visit(node)

    def visit_Name(self, node):
        if node.id == self.symbol and isinstance(node.ctx, ast.Load):
            self._record(node.lineno, "name")

    def visit_Import(self, node):
        for a in node.names:
            if a.name == self.symbol or a.asname == self.symbol:
                self._record(node.lineno, "import")

    def visit_ImportFrom(self, node):
        for a in node.names:
            if a.name == self.symbol or a.asname == self.symbol:
                self._record(node.lineno, "import")


def who_uses(symbol: str, path: str = ".", ext: str = ".py",
             include_def: bool = False, max_files: int = 500) -> str:
    """查 symbol 在项目中的引用点（AST 精确名匹配，不做类型推断/LSP）。
    path: 相对 WORKSPACE 的目录，默认 "."；自动跳过 .git/__pycache__/.bak*。
    ext: 文件后缀，默认 ".py"。
    include_def: False 只报引用，不报 def/class 定义点。
    返回 JSON 字符串，含 symbol/files_scanned/hits/errors/truncated。
    """
    try:
        root = safe_path(path)
        if not os.path.isdir(root):
            return json.dumps({"ok": False, "error": "[错误] 不是目录: %s" % path},
                              ensure_ascii=False)
        if not ext.startswith("."):
            ext = "." + ext
        from repo_map import SKIP_DIRS
        hits = []
        errors = []
        scanned = 0
        truncated = False
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            for fn in sorted(filenames):
                if not fn.endswith(ext):
                    continue
                if ".bak" in fn:
                    continue
                if scanned >= max_files:
                    truncated = True
                    break
                full = os.path.join(dirpath, fn)
                scanned += 1
                rel = os.path.relpath(full, root).replace(os.sep, "/")
                try:
                    tree, src, _, _ = _ast_parse_file(full)
                except Exception as e:
                    if len(errors) < 100:
                        errors.append({"file": rel, "error": str(e)[:200]})
                    continue
                if tree is None:
                    if len(errors) < 100:
                        errors.append({"file": rel, "error": str(src)[:200]})
                    continue
                v = _WhoUsesVisitor(symbol, include_def)
                try:
                    v.visit(tree)
                except Exception as e:
                    if len(errors) < 100:
                        errors.append({"file": rel, "error": ("visit: %s" % e)[:200]})
                    continue
                for lineno, kind, scope in v.hits:
                    hits.append({"file": rel, "line": lineno, "kind": kind, "scope": scope})
            if truncated:
                break
        hits.sort(key=lambda h: (h["file"], h["line"]))
        return json.dumps({"ok": True, "symbol": symbol, "files_scanned": scanned,
                           "hits": hits, "errors": errors, "truncated": truncated},
                          ensure_ascii=False, indent=2)
    except Exception as e:
        return json.dumps({"ok": False, "error": "[错误] who_uses 失败: %s" % e},
                          ensure_ascii=False)


def list_dir(path: str = ".") -> str:

    try:
        full = safe_path(path)
        names = sorted(os.listdir(full))
        if not names:
            return "(空目录)"
        lines = []
        for name in names[:200]:
            mark = "[目录]" if os.path.isdir(os.path.join(full, name)) else "[文件]"
            lines.append(f"{mark} {name}")
        if len(names) > 200:
            lines.append(f"...(共 {len(names)} 项,仅显示前 200 项)")
        return "\n".join(lines)
    except Exception as e:
        return f"[错误] 列目录失败: {e}"


def run_command(command: str) -> str:
    """执行 shell 命令。返回值首行显式标注退出码,便于模型判断验证是否通过。

    仅适合单行命令或带管道的组合。多行脚本请用 run_script。
    """
    # 简单危险命令拦截
    if any(d in command.lower() for d in DANGEROUS):
        return "[拒绝] 危险命令已拦截,请手动执行"
    # 检测会被 cmd.exe 截断的跨行模式:python -c "..." / node -e "..." / powershell -Command "..."
    lower = command.lower()
    inline_flags = ("python -c", "python3 -c", "node -e", "node --eval",
                    "powershell -command", "pwsh -command", "pwsh -c")
    if any(f in lower for f in inline_flags):
        if "\n" in command or command.count("\n") > 0:
            return ("[拒绝] 检测到内联解释器命令含换行符。cmd.exe 会把换行当命令分隔符截断,"
                    "导致只有第一行执行且退出码仍为 0(静默失败)。"
                    "请改用 run_script(language='python', code='完整多行脚本')。")
    try:
        result = subprocess.run(
            command,
            shell=True,
            cwd=WORKSPACE,
            capture_output=True,
            stdin=subprocess.DEVNULL,  # 关键:不让子进程读 agent 的 stdin,否则会永久挂起
            timeout=TIMEOUT,
        )
        rc = result.returncode
        # 不传 text=True:手动解码,避免 PYTHONUTF8=1 强制 UTF-8 把 GBK 输出解成乱码。
        # 依次尝试 utf-8(严格) -> gbk(中文 Windows cmd 默认) -> utf-8(replace 兜底)。
        def _decode_output(b: bytes) -> str:
            if not b:
                return ""
            try:
                return b.decode("utf-8")
            except UnicodeDecodeError:
                pass
            try:
                return b.decode("gbk")
            except UnicodeDecodeError:
                return b.decode("utf-8", errors="replace")
        stdout = _decode_output(result.stdout or b"")
        stderr = _decode_output(result.stderr or b"")

        # 分块输出,stdout / stderr 各自标明,避免模型把警告当成错误
        parts = []
        if stdout.strip():
            parts.append("[stdout]\n" + stdout)
        if stderr.strip():
            parts.append("[stderr]\n" + stderr)
        body = "\n".join(parts) if parts else "(无输出)"

        if len(body) > 5000:
            body = body[:5000] + "\n...(已截断,原始 %d 字符)" % len(body)

        if rc == 0:
            head = "[成功] 退出码 0"
        else:
            head = "[失败] 退出码 %d —— 命令未成功,请分析下面输出并修复,不要原样重试" % rc
        return head + "\n" + body
    except subprocess.TimeoutExpired:
        return f"[失败] 命令超时({TIMEOUT}秒),可能死循环或等待输入"
    except Exception as e:
        return f"[失败] 命令执行异常: {e}"


def run_script(language: str, code: str) -> str:
    """执行一段多行脚本。写入临时文件后执行,天然支持多行,不经 shell 转义。

    language: python / node / powershell / cmd
    code: 完整的脚本内容(多行)
    """
    lang = (language or "").strip().lower()
    runners = {
        "python": ("py", ["python"]),
        "python3": ("py", ["python"]),
        "node": ("js", ["node"]),
        "javascript": ("js", ["node"]),
        "powershell": ("ps1", ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]),
        "pwsh": ("ps1", ["pwsh", "-NoProfile", "-File"]),
        "cmd": ("bat", None),  # None 表示直接 cmd /c 执行
        "batch": ("bat", None),
    }
    if lang not in runners:
        return f"[错误] 不支持的 language: {language}。可选: python / node / powershell / cmd"
    ext, runner = runners[lang]

    # 临时文件放工作区的 .agent_tmp,便于清理和调试
    tmp_dir = os.path.join(WORKSPACE, ".agent_tmp")
    os.makedirs(tmp_dir, exist_ok=True)
    fname = f"script_{uuid.uuid4().hex[:8]}.{ext}"
    tmp_path = os.path.join(tmp_dir, fname)

    try:
        with open(tmp_path, "w", encoding="utf-8", newline=chr(10)) as f:
            f.write(code)

        if runner is None:  # cmd: cmd /c script.bat
            cmd = ["cmd", "/c", tmp_path]
        elif lang in ("python", "python3"):
            cmd = [runner[0], tmp_path]
        elif lang in ("node", "javascript"):
            cmd = [runner[0], tmp_path]
        else:  # powershell/pwsh: 解释器 + 开关 + -File 路径
            cmd = list(runner) + [tmp_path]

        result = subprocess.run(
            cmd,
            cwd=WORKSPACE,
            capture_output=True,
            stdin=subprocess.DEVNULL,
            timeout=TIMEOUT,
        )
        rc = result.returncode

        def _decode(b: bytes) -> str:
            if not b:
                return ""
            try:
                return b.decode("utf-8")
            except UnicodeDecodeError:
                pass
            try:
                return b.decode("gbk")
            except UnicodeDecodeError:
                return b.decode("utf-8", errors="replace")

        stdout = _decode(result.stdout or b"")
        stderr = _decode(result.stderr or b"")
        parts = []
        if stdout.strip():
            parts.append("[stdout]\n" + stdout)
        if stderr.strip():
            parts.append("[stderr]\n" + stderr)
        body = "\n".join(parts) if parts else "(无输出)"
        if len(body) > 5000:
            body = body[:5000] + "\n...(已截断,原始 %d 字符)" % len(body)

        if rc == 0:
            head = "[成功] 退出码 0"
        else:
            head = "[失败] 退出码 %d —— 脚本未成功,请分析下面输出并修复" % rc
        return head + "\n" + body
    except subprocess.TimeoutExpired:
        return f"[失败] 脚本执行超时({TIMEOUT}秒),可能死循环或等待输入"
    except Exception as e:
        return f"[失败] 脚本执行异常: {e}"
    finally:
        try:
            os.remove(tmp_path)
        except Exception:
            pass


def search_code(pattern: str, path: str = ".", include: str = "",
                exclude: str = "", max_results: int = 50) -> str:
    """按正则或字面量搜索文件内容,返回 文件:行号:内容。"""
    try:
        import re as _re
        import fnmatch as _fnmatch
        full = safe_path(path)
        try:
            regex = _re.compile(pattern)
        except _re.error:
            regex = _re.compile(_re.escape(pattern))

        include_pats = [p.strip() for p in include.split(",") if p.strip()]
        exclude_pats = [p.strip() for p in exclude.split(",") if p.strip()]
        skip_dirs = {".git", "node_modules", "__pycache__", ".venv", "venv",
                     "dist", "build", ".idea", ".vscode"}

        # 单文件模式:path 指向文件时直接搜该文件
        if os.path.isfile(full):
            try:
                text, _ = _read_text(full)
            except Exception as e:
                return "[错误] 读取失败: %s" % e
            results = []
            base = os.path.dirname(full)
            for lineno, line in enumerate(text.split("\n"), 1):
                if regex.search(line):
                    rel = os.path.relpath(full, base)
                    results.append("%s:%d:%s" % (rel, lineno, line.strip()[:200]))
                    if len(results) >= max_results:
                        break
            if not results:
                return "(无匹配,文件: %s, pattern: %r)" % (path, pattern)
            header = "(共 %d 条%s)" % (
                len(results), ",已达上限" if len(results) >= max_results else "")
            return header + "\n" + "\n".join(results)

        results = []
        for root, dirs, files in os.walk(full):
            dirs[:] = [d for d in dirs if d not in skip_dirs]
            for fn in files:
                if include_pats and not any(_fnmatch.fnmatch(fn, p) for p in include_pats):
                    continue
                if exclude_pats and any(_fnmatch.fnmatch(fn, p) for p in exclude_pats):
                    continue
                fp = os.path.join(root, fn)
                try:
                    text, _ = _read_text(fp)
                except Exception:
                    continue
                for lineno, line in enumerate(text.split("\n"), 1):
                    if regex.search(line):
                        rel = os.path.relpath(fp, full)
                        results.append("%s:%d:%s" % (rel, lineno, line.strip()[:200]))
                        if len(results) >= max_results:
                            break
                if len(results) >= max_results:
                    break
            if len(results) >= max_results:
                break

        if not results:
            return "(无匹配,搜索路径: %s, pattern: %r)" % (path, pattern)
        header = "(共 %d 条%s)" % (
            len(results), ",已达上限" if len(results) >= max_results else "")
        return header + "\n" + "\n".join(results)
    except Exception as e:
        return "[错误] 搜索失败: %s" % e


def find_files(pattern: str, path: str = ".") -> str:
    """按 glob 模式递归查找文件(如 *.py, **/*.ts, src/**/*.js)。"""
    try:
        import fnmatch as _fnmatch
        full = safe_path(path)
        if os.path.isfile(full):
            fn = os.path.basename(full)
            if _fnmatch.fnmatch(fn, pattern) or _fnmatch.fnmatch(fn, pattern):
                return "(共 1 个文件)\n" + fn
            return "(无匹配文件,文件: %s, pattern: %r)" % (path, pattern)
        skip_dirs = {".git", "node_modules", "__pycache__", ".venv", "venv",
                     "dist", "build", ".idea", ".vscode"}
        results = []
        for root, dirs, files in os.walk(full):
            dirs[:] = [d for d in dirs if d not in skip_dirs]
            for fn in files:
                rel = os.path.relpath(os.path.join(root, fn), full)
                rel_slash = rel.replace(os.sep, "/")
                if (_fnmatch.fnmatch(rel_slash, pattern)
                        or _fnmatch.fnmatch(fn, pattern)):
                    results.append(rel_slash)
        results.sort()
        if not results:
            return "(无匹配文件,路径: %s, pattern: %r)" % (path, pattern)
        cap = 200
        out = results[:cap]
        header = "(共 %d 个文件%s)" % (
            len(results), ",仅显示前 %d" % cap if len(results) > cap else "")
        return header + "\n" + "\n".join(out)
    except Exception as e:
        return "[错误] 查找失败: %s" % e


def attempt_completion(result: str) -> str:
    """模型显式声明任务完成。实际结束逻辑由 agent_loop 分发层处理。"""
    return result or "(任务完成)"


def ask_followup_question(question: str, options=None) -> str:
    """模型向用户提问。实际等待逻辑由 agent_loop 分发层处理。"""
    return "[等待回答] %s" % (question or "")


def restart_self(reason: str = "agent") -> str:
    """触发 Easycode 主进程自重启。

    前提：改动已通过验证（npm run typecheck 或 py_compile）。
    Easycode 主进程轮询 .easycode/need_restart，发现后 app.relaunch()。
    """
    pkg = os.path.join(WORKSPACE, "package.json")
    if not os.path.isfile(pkg):
        return "[错误] 当前工作区不是 Easycode 项目(无 package.json)，restart_self 不适用"
    try:
        import json as _json
        data = _json.load(open(pkg, encoding='utf-8'))
        if data.get('name') != 'easycode':
            return f"[错误] 当前项目不是 Easycode(name={data.get('name')})，restart_self 不适用"
    except Exception as e:
        return f"[错误] 读取 package.json 失败: {e}"

    easycode_dir = os.path.join(WORKSPACE, ".easycode")
    os.makedirs(easycode_dir, exist_ok=True)
    flag = os.path.join(easycode_dir, "need_restart")
    with open(flag, "w", encoding="utf-8") as f:
        f.write(reason)
    return f"[成功] 已写重启标记: {flag}。Easycode 将在 1 秒内自动重启(当前对话会中断)。"


# ============ 项目经验库(memory) ============
_MEMORY_ALPHABET = string.ascii_lowercase + string.digits
_MEMORY_SECTION_ORDER = ["现象", "根因", "修复", "文件", "验证", "教训"]


def _memory_db_path() -> str:
    """记忆库位置: <WORKSPACE>/.agent/memory.json"""
    return os.path.join(WORKSPACE, ".agent", "memory.json")


def _load_memory() -> dict:
    p = _memory_db_path()
    if not os.path.exists(p):
        return {}
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def _save_memory(data: dict) -> None:
    p = _memory_db_path()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def _memory_new_id(data: dict, n: int = 6) -> str:
    while True:
        rid = "".join(secrets.choice(_MEMORY_ALPHABET) for _ in range(n))
        if rid not in data:
            return rid


def _memory_now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def memory(op: str, **kw) -> str:
    """项目经验库: search / get / write。按 title 合并。"""
    if op == "search":
        data = _load_memory()
        tag = kw.get("tag")
        mstatus = kw.get("memory_status")
        mtype = kw.get("type")
        text = kw.get("text")
        full = bool(kw.get("full", False))
        kws = [k.lower() for k in text.split() if k] if text else []

        def _item_ok(it):
            if tag and tag.lower() not in [str(t).lower() for t in it.get("tags", [])]:
                return False
            if mstatus and it.get("status") != mstatus:
                return False
            if mtype and it.get("type") != mtype:
                return False
            return True

        def _collect(mode):
            hits = []
            for rid, it in data.items():
                if not _item_ok(it):
                    continue
                if kws and mode:
                    blob = json.dumps(it, ensure_ascii=False).lower()
                    if mode == "and" and not all(k in blob for k in kws):
                        continue
                    if mode == "or" and not any(k in blob for k in kws):
                        continue
                item = {"id": rid, **it}
                if not full:
                    item = {k: item.get(k) for k in ("id", "title", "type", "status", "tags")}
                hits.append(item)
            return hits

        if kws:
            hits = _collect("and")
            if hits:
                return json.dumps({"count": len(hits), "items": hits}, ensure_ascii=False, indent=2)
            hits = _collect("or")
            if hits:
                return ("[提示] 关键词未全命中，按任一关键词降级匹配：\n"
                        + json.dumps({"count": len(hits), "items": hits}, ensure_ascii=False, indent=2))
            return "(0 条记忆命中)"

        hits = _collect(None)
        if not hits:
            return "(0 条记忆命中)"
        return json.dumps({"count": len(hits), "items": hits}, ensure_ascii=False, indent=2)

    if op == "get":
        rid = kw.get("id")
        if not rid:
            return "[错误] get 需要 id 参数"
        data = _load_memory()
        if rid not in data:
            return f"[错误] 未找到记忆: {rid}"
        return json.dumps({"id": rid, **data[rid]}, ensure_ascii=False, indent=2)

    if op == "write":
        title = str(kw.get("title", "")).strip()
        if not title:
            return "[错误] write 需要 title"
        mtype = str(kw.get("type", "note"))
        mstatus = str(kw.get("memory_status", "resolved"))
        tags = kw.get("tags") or []
        if not isinstance(tags, list):
            tags = []
        tags = [str(t) for t in tags]
        sections = kw.get("sections") or {}
        if not isinstance(sections, dict):
            sections = {}
        sections = {str(k): str(v) for k, v in sections.items()}
        ordered = {}
        for k in _MEMORY_SECTION_ORDER:
            if k in sections:
                ordered[k] = sections[k]
        for k, v in sections.items():
            if k not in ordered:
                ordered[k] = v

        data = _load_memory()
        now = _memory_now()
        existing = next((rid for rid, it in data.items() if it.get("title") == title), None)
        if existing:
            rid = existing
            e = data[rid]
            if mtype:
                e["type"] = mtype
            if mstatus:
                e["status"] = mstatus
            if tags:
                e["tags"] = sorted(set(e.get("tags", [])) | set(tags))
            merged = dict(e.get("sections", {}))
            merged.update(ordered)
            e["sections"] = merged
            e["updated"] = now
            created = False
        else:
            rid = _memory_new_id(data)
            data[rid] = {
                "title": title, "type": mtype, "status": mstatus,
                "tags": sorted(set(tags)), "sections": ordered,
                "created": now, "updated": now,
            }
            created = True
        _save_memory(data)
        return json.dumps({"ok": True, "id": rid, "created": created}, ensure_ascii=False)

    return f"[错误] 未知 op: {op}（支持 search/get/write）"


# ============ 审批预览(不写盘) ============
def preview_write(path: str, content: str, encoding: str = "utf-8") -> tuple:
    """write_file 预览: 返回 (unified_diff 文本, None) 或 (None, 错误)。不写盘。"""
    import difflib as _dl
    try:
        full = safe_path(path)
        if os.path.exists(full):
            old, _ = _read_text(full)
        else:
            old = ""
        diff = "".join(_dl.unified_diff(
            old.splitlines(keepends=True),
            content.splitlines(keepends=True),
            fromfile=path + " (原)", tofile=path + " (新)"))
        return (diff or "(无变化)"), None
    except Exception as e:
        return None, f"[错误] 预览失败: {e}"


def preview_edit(path: str, old_text: str, new_text: str) -> tuple:
    """edit_file 预览: 复用三级匹配逻辑(dry_run),不写盘。"""
    return edit_file(path, old_text, new_text, dry_run=True)


TOOL_MAP = {
    "read_file": read_file,
    "write_file": write_file,
    "edit_file": edit_file,
    "list_dir": list_dir,
    "run_command": run_command,
    "run_script": run_script,
    "search_code": search_code,
    "find_files": find_files,
    "restart_self": restart_self,
    "memory": memory,
    "attempt_completion": attempt_completion,
    "ask_followup_question": ask_followup_question,
    "list_symbols": list_symbols,
    "read_symbol": read_symbol,
    "patch_symbol": patch_symbol,
    "who_uses": who_uses,
}
