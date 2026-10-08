"""工具执行器:模型只负责"说要调用什么",真正执行的是这里。"""
import os
import shutil
import subprocess

# 工作区围栏:默认为启动时的当前目录;可用环境变量 AGENT_WORKSPACE 覆盖
WORKSPACE = os.path.abspath(os.environ.get("AGENT_WORKSPACE") or os.getcwd())

# 单条命令超时时间(秒),可用 AGENT_TIMEOUT 覆盖
TIMEOUT = int(os.environ.get("AGENT_TIMEOUT", "30"))

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


def read_file(path: str) -> str:
    try:
        content, _ = _read_text(safe_path(path))
        return content
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
        return f"[成功] 已写入 {path}(编码: {enc}{note})"
    except Exception as e:
        return f"[错误] 写入失败: {e}"


def edit_file(path: str, old_text: str, new_text: str) -> str:
    try:
        full = safe_path(path)
        content, enc = _read_text(full)
        if old_text not in content:
            return "[错误] 未在文件中找到要替换的文本,请先 read_file 确认内容"
        _backup(full)
        content = content.replace(old_text, new_text, 1)
        with open(full, "w", encoding=enc, newline="") as f:
            f.write(content)
        return f"[成功] 已修改 {path}(编码: {enc},备份: {full}.bak)"
    except Exception as e:
        return f"[错误] 修改失败: {e}"


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
    # 简单危险命令拦截
    if any(d in command.lower() for d in DANGEROUS):
        return "[拒绝] 危险命令已拦截,请手动执行"
    try:
        result = subprocess.run(
            command,
            shell=True,
            cwd=WORKSPACE,
            capture_output=True,
            text=True,
            errors="replace",
            timeout=TIMEOUT,
        )
        output = (result.stdout or "") + (result.stderr or "")
        return output[:5000] if output.strip() else "[成功] 命令执行完毕,无输出"
    except subprocess.TimeoutExpired:
        return f"[错误] 命令执行超时({TIMEOUT}秒),请检查是否有死循环"
    except Exception as e:
        return f"[错误] 命令执行失败: {e}"


TOOL_MAP = {
    "read_file": read_file,
    "write_file": write_file,
    "edit_file": edit_file,
    "list_dir": list_dir,
    "run_command": run_command,
}
