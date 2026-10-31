"""轻量 repo map:提取工作区文件骨架(目录 + 行数 + 顶层符号),供 system prompt 导航用。

设计目标:
- 让模型先看到"有什么",再决定读哪个文件,避免盲目 list_dir 逐层探索。
- token 预算 ~1500(约 6000 字符),超出截断。
- 无第三方依赖:Python 用 ast,TS/JS 用正则。
"""
import ast
import json
import os
import re

SKIP_DIRS = {
    ".git", "node_modules", "__pycache__", ".venv", "venv", "env",
    "dist", "build", "out", "release", "target", ".next", ".nuxt",
    ".idea", ".vscode", ".mypy_cache", ".pytest_cache", "coverage",
    "dist-electron", ".cache", ".turbo", ".git",
}
SKIP_FILES = {
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "poetry.lock",
    "Cargo.lock", "go.sum", "composer.lock",
}
CODE_EXTS = {
    ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".c", ".h", ".cpp", ".hpp", ".cc", ".cs", ".java", ".go", ".rs",
}
MAX_CHARS = 6000
MAX_SYMBOLS_PER_FILE = 8
MAX_FILES = 400
MAX_FILE_SIZE = 1024 * 1024  # 1MB 以上的文件跳过符号提取


def _py_symbols(path: str) -> list:
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            tree = ast.parse(f.read())
    except Exception:
        return []
    out = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            out.append(node.name)
    return out


_JS_RE = re.compile(
    r"^(?:export\s+(?:default\s+)?)?(?:async\s+)?"
    r"(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)",
    re.MULTILINE,
)


def _js_symbols(path: str) -> list:
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            src = f.read()
    except Exception:
        return []
    seen = []
    for m in _JS_RE.finditer(src):
        name = m.group(1)
        if name not in seen:
            seen.append(name)
    return seen


def _file_lines(path: str) -> int:
    try:
        with open(path, "rb") as f:
            return sum(1 for _ in f)
    except Exception:
        return 0


def build_repo_map(workspace: str, max_chars: int = MAX_CHARS) -> str:
    """返回工作区骨架文本。workspace 不存在或无代码文件时返回空串。"""
    workspace = os.path.abspath(workspace)
    if not os.path.isdir(workspace):
        return ""

    entries = []
    total_files = 0
    truncated = False
    for root, dirs, files in os.walk(workspace):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        rel_root = os.path.relpath(root, workspace)
        if rel_root == ".":
            rel_root = ""
        for fn in sorted(files):
            if fn in SKIP_FILES or fn.endswith((".min.js", ".map", ".pyc", ".pyo")):
                continue
            ext = os.path.splitext(fn)[1].lower()
            if ext not in CODE_EXTS:
                continue
            fp = os.path.join(root, fn)
            rel = os.path.join(rel_root, fn) if rel_root else fn
            rel = rel.replace(os.sep, "/")
            total_files += 1
            if total_files > MAX_FILES:
                truncated = True
                break
            try:
                size = os.path.getsize(fp)
            except OSError:
                continue
            n = _file_lines(fp)
            if size > MAX_FILE_SIZE:
                syms = []
            elif ext == ".py":
                syms = _py_symbols(fp)
            elif ext in (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"):
                syms = _js_symbols(fp)
            else:
                syms = []
            entries.append((rel, n, syms))
        if truncated:
            break

    if not entries:
        return ""

    lines = []
    pkg = os.path.join(workspace, "package.json")
    if os.path.isfile(pkg):
        try:
            with open(pkg, encoding="utf-8") as f:
                data = json.load(f)
            scripts = data.get("scripts") or {}
            if scripts:
                items = list(scripts.items())[:8]
                lines.append("# npm scripts: " + ", ".join(f"{k}={v}" for k, v in items))
        except Exception:
            pass

    prev_dir = None
    for rel, n, syms in entries:
        d = os.path.dirname(rel) or "."
        if d != prev_dir:
            lines.append("")
            lines.append(f"[{d}]")
            prev_dir = d
        sym = ", ".join(syms[:MAX_SYMBOLS_PER_FILE])
        if len(syms) > MAX_SYMBOLS_PER_FILE:
            sym += ", ..."
        line = f"  {os.path.basename(rel)} ({n}L)"
        if sym:
            line += f": {sym}"
        lines.append(line)

    text = "\n".join(lines).strip()
    if len(text) > max_chars:
        text = text[:max_chars] + "\n... (repo map 已截断)"
    elif truncated:
        text += "\n... (文件数超过上限,repo map 已截断)"
    return text
