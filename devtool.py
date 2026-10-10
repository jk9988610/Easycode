"""
EasyCode DevTool — 可视化 patch / 文件操作 / typecheck / commit （深色主题）
"""
import os
import sys
import json
import time
import shutil
import threading
import re
import subprocess


def _find_python(work_dir=None, override=None):
    import os as _os
    import shutil as _sh
    if override and _os.path.exists(override):
        return override
    if work_dir:
        for v in (".venv", "venv", "env"):
            for sub in ("Scripts/python.exe", "Scripts/python", "bin/python", "bin/python3"):
                p = _os.path.join(work_dir, v, sub)
                if _os.path.exists(p):
                    return p
    env = _os.environ.get("DEVTOOL_PYTHON")
    if env and _os.path.exists(env):
        return env
    for name in ("python", "python3", "py"):
        p = _sh.which(name)
        if p:
            return p
    import sys as _sys
    if getattr(sys, "frozen", False):
        # 打包后没有 python 解释器，让系统 PATH 里的 python 顶上
        return "python"
    return _sys.executable


def _find_node_exe():
    import os as _os
    import shutil as _sh
    env = _os.environ.get("NODE_EXE")
    if env and _os.path.exists(env):
        return env
    p = _sh.which("node")
    if p:
        return p
    candidates = [
        "C:/Program Files/nodejs/node.exe",
        "C:/Program Files (x86)/nodejs/node.exe",
        _os.path.expandvars("%LOCALAPPDATA%/Programs/nodejs/node.exe"),
        _os.path.expandvars("%APPDATA%/nvm/node.exe"),
        _os.path.expandvars("%USERPROFILE%/.volta/bin/node.exe"),
    ]
    for c in candidates:
        if _os.path.exists(c):
            return c
    if _os.name == "nt":
        try:
            import winreg
            for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
                try:
                    with winreg.OpenKey(hive, "SOFTWARE" + chr(92) + "Node.js") as k:
                        base, _ = winreg.QueryValueEx(k, "InstallPath")
                        exe = _os.path.join(base, "node.exe")
                        if _os.path.exists(exe):
                            return exe
                except OSError:
                    pass
        except ImportError:
            pass
    raise RuntimeError("Cannot find node.exe. Install Node.js or set NODE_EXE env var.")

def _resolve_exe(name):
    import os as _os
    if name == "node":
        try:
            return _find_node_exe()
        except RuntimeError:
            return name
    if name in ("npm", "npm.cmd", "npx", "npx.cmd"):
        try:
            np = _find_node_exe()
        except RuntimeError:
            return name
        base = _os.path.dirname(np)
        target = _os.path.join(base, name if name.endswith(".cmd") else name + ".cmd")
        if _os.path.exists(target):
            return target
        return name
    if name in ("python", "python3", "python.exe"):
        import sys as _sys
        return _sys.executable
    if name in ("tsc", "tsc.cmd"):
        local = _os.path.join(ROOT, "node_modules", ".bin", "tsc.cmd")
        if _os.path.exists(local):
            return local
        return name
    return name


def _patch_cmd(name, work_dir=None, py_override=None):
    low = (name or "").lower()
    if low.endswith(".py"):
        return [_find_python(work_dir, py_override), name]
    if low.endswith(".cjs") or low.endswith(".js"):
        try:
            return [_find_node_exe(), name]
        except RuntimeError:
            return ["node", name]
    if low.endswith(".ps1"):
        return ["powershell", "-ExecutionPolicy", "Bypass", "-File", name]
    if low.endswith(".sh"):
        return ["bash", name]
    return [name]

def _looks_like_powershell(cmd):
    if not cmd:
        return False
    import re as _re
    stripped = cmd.strip()
    first = stripped.split(None, 1)[0].lower()
    # 明确的命令行工具：走 cmd
    if first in (
        "node", "python", "python3", "py", "npm", "npx", "git",
        "dir", "type", "echo", "del", "copy", "move", "mkdir", "rmdir",
        "cd", "start", "call", "set",
    ):
        return False
    # PowerShell cmdlet 命名模式: Verb-Noun
    verbs = {
        "add", "clear", "close", "copy", "enter", "exit", "find", "format",
        "get", "hide", "join", "lock", "move", "new", "open", "optimize",
        "pop", "push", "redo", "remove", "rename", "reset", "resize",
        "resolve", "restart", "resume", "save", "search", "select", "set",
        "show", "skip", "split", "start", "step", "stop", "submit",
        "suspend", "switch", "tee", "test", "trace", "unblock", "undo",
        "uninstall", "unlock", "unregister", "update", "use", "wait",
        "watch", "write", "out", "invoke", "measure", "compare",
        "convertto", "convertfrom", "export", "import", "read", "receive",
        "send", "sort", "group", "merge", "register", "debug", "disable",
        "enable", "grant", "revoke", "checkpoint", "complete", "compress",
        "expand", "install", "publish", "restore", "protect", "backup",
        "block", "confirm", "deny", "approve", "assert",
    }
    m = _re.match(r"^([a-z]+)-", first)
    if m and m.group(1) in verbs:
        return True
    # 其他 PowerShell 特征
    hints = ("-ErrorAction", "-Force", "-Recurse", "$env:")
    return any(h in cmd for h in hints)

def _rewrite_shell_cmd(cmd):
    if not cmd:
        return cmd
    parts = cmd.split(None, 1)
    if not parts:
        return cmd
    first = parts[0]
    resolved = _resolve_exe(first)
    if resolved != first:
        if " " in resolved:
            resolved = chr(34) + resolved + chr(34)
        if len(parts) == 2:
            return resolved + " " + parts[1]
        return resolved
    return cmd


import tkinter as tk
from tkinter import ttk, scrolledtext, messagebox

if getattr(sys, "frozen", False):
    APP_DIR = os.path.dirname(os.path.abspath(sys.executable))
else:
    APP_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = APP_DIR

# ================= 配色 =================
BG        = "#000000"
BG_PANEL  = "#0a0a0a"
BG_ENTRY  = "#030303"
FG        = "#e6edf2"
FG_MUTED  = "#8b949e"
ACCENT    = "#4ea8ff"
ACCENT_H  = "#79b8ff"
LINE      = "#2a2a2a"
HOVER     = "#141414"
DANGER    = "#f85149"
OK        = "#3fb950"
WARN      = "#d29922"



def apply_dark_theme(root):
    style = ttk.Style(root)
    try:
        style.theme_use("clam")
    except tk.TclError:
        pass
    root.configure(bg=BG)

    style.configure("TNotebook", background=BG, borderwidth=0)
    style.configure("TNotebook.Tab",
                    background=BG_PANEL, foreground=FG_MUTED,
                    padding=(14, 7), borderwidth=0)
    style.map("TNotebook.Tab",
              background=[("selected", BG), ("active", HOVER)],
              foreground=[("selected", ACCENT), ("active", FG)])

    style.configure("TLabelframe", background=BG, foreground=FG_MUTED,
                    bordercolor="#141414", lightcolor="#141414", darkcolor="#141414")
    style.configure("TLabelframe.Label", background=BG, foreground="#4ea8ff")

    style.configure("TFrame", background=BG)
    style.configure("TLabel", background=BG, foreground=FG)

    style.configure("TButton",
                    background=BG_PANEL, foreground=FG,
                    bordercolor=LINE, lightcolor=LINE, darkcolor=LINE,
                    focuscolor=ACCENT, relief="flat", padding=(10, 5))
    style.map("TButton",
              background=[("active", HOVER), ("pressed", ACCENT)],
              foreground=[("active", FG)],
              bordercolor=[("active", ACCENT)])

    style.configure("TEntry",
                    fieldbackground=BG_ENTRY, foreground=FG,
                    bordercolor=LINE, lightcolor=LINE, darkcolor=LINE,
                    insertcolor=FG)
    style.map("TEntry", bordercolor=[("focus", ACCENT)])

    style.configure("TCombobox",
                    fieldbackground=BG_ENTRY, background=BG_PANEL,
                    foreground=FG, arrowcolor=FG_MUTED,
                    bordercolor=LINE, lightcolor=LINE, darkcolor=LINE)
    style.map("TCombobox",
              fieldbackground=[("readonly", BG_ENTRY)],
              foreground=[("readonly", FG)],
              bordercolor=[("focus", ACCENT)],
              arrowcolor=[("active", ACCENT)])
    root.option_add("*TCombobox*Listbox.background", BG_ENTRY)
    root.option_add("*TCombobox*Listbox.foreground", FG)
    root.option_add("*TCombobox*Listbox.selectBackground", ACCENT)
    root.option_add("*TCombobox*Listbox.selectForeground", BG)
    root.option_add("*TCombobox*Listbox.borderWidth", "0")

    style.configure("TSpinbox",
                    fieldbackground=BG_ENTRY, background=BG_PANEL,
                    foreground=FG, arrowcolor=FG_MUTED,
                    bordercolor=LINE, lightcolor=LINE, darkcolor=LINE,
                    insertcolor=FG)
    style.map("TSpinbox",
              fieldbackground=[("readonly", BG_ENTRY), ("focus", BG_ENTRY)],
              foreground=[("readonly", FG)],
              bordercolor=[("focus", ACCENT)],
              arrowcolor=[("active", ACCENT)])

    style.configure("TCheckbutton",
                    background=BG, foreground=FG,
                    indicatorcolor=BG_ENTRY, focuscolor=BG,
                    bordercolor=LINE, lightcolor=BG, darkcolor=BG)
    style.map("TCheckbutton",
              background=[("active", BG), ("selected", BG)],
              foreground=[("active", FG), ("selected", FG)],
              indicatorcolor=[("selected", ACCENT), ("active", HOVER)])

    style.configure("TRadiobutton",
                    background=BG, foreground=FG,
                    indicatorcolor=BG_ENTRY, focuscolor=BG,
                    bordercolor=LINE)
    style.map("TRadiobutton",
              background=[("active", BG), ("selected", BG)],
              foreground=[("active", FG), ("selected", FG)],
              indicatorcolor=[("selected", ACCENT)])

    # 滚动条：透明灰
    # 滚动条：透明轨道，无边框，加宽
    for _orient in ("Vertical", "Horizontal"):
        _name = _orient + ".TScrollbar"
        style.configure(_name,
                        background="#3a3a3a", troughcolor=BG,
                        bordercolor=BG, arrowcolor=BG,
                        lightcolor="#3a3a3a", darkcolor="#3a3a3a",
                        relief="flat", borderwidth=0,
                        arrowsize=0, width=14)
        style.map(_name,
                  background=[("active", "#5a5a5a"), ("pressed", "#6a6a6a")],
                  arrowcolor=[("active", BG)])
    for _orient in ("Vertical", "Horizontal"):
        _name = _orient + ".TScrollbar"
        style.configure(_name,
                        background="#2a2a2a", troughcolor=BG,
                        bordercolor=BG, arrowcolor="#666666",
                        lightcolor="#2a2a2a", darkcolor="#2a2a2a",
                        relief="flat", borderwidth=0)
        style.map(_name,
                  background=[("active", "#3a3a3a"), ("pressed", "#4a4a4a")],
                  arrowcolor=[("active", "#999999")])


CONFIG_FILE = os.path.join(APP_DIR, "devtool-config.json")

HELP_TEXT = """DevTool 使用说明（通用项目开发辅助）

本工具用于 AI 协作开发：AI 生成 patch 脚本 / 命令 -> 你粘贴 -> 工具执行 -> 输出结果回传 AI。

═══ 四个 Tab ═══
[文件操作]  粘 JSON，批量 write/append/delete/mkdir/shell
[Patch & Commit]  选脚本、运行、验证、提交
[设置]  工作目录、字体、Python、行为
[帮助]  本页

═══ 文件操作 JSON 格式 ═══
[
  {"op":"write",  "path":"相对路径", "content":"文件内容"},
  {"op":"append", "path":"...", "content":"追加内容"},
  {"op":"delete", "path":"..."},
  {"op":"mkdir",  "path":"..."},
  {"op":"shell",  "cmd":"任意命令"}
]
路径相对工作目录。write/append 自动创建父目录。

═══ shell 自动识别 ═══
不用记 cmd / PowerShell 的区别：
  - node / python / npm / git / dir / echo / copy / del ... -> 走 cmd
  - Add-Content / Remove-Item / Get-ChildItem / Set-Item / ... -> 自动走 PowerShell
  - 含 -ErrorAction / -Force / $env: 等特征的 -> 走 PowerShell
输出行前会标 [shell(cmd)] 或 [shell(psh)]。

═══ 智能运行 ═══
把 JSON 或纯 shell 命令粘到输入框（或复制到剪贴板），点 [智能运行]：
  1. 读输入框 / 剪贴板（按"智能运行源"设置）
  2. 自动识别三种输入:
     - JSON 数组 -> 执行文件操作
     - patch-xxx.* 文件名 -> 切到 Patch Tab 选中并运行
     - 单行/多行 shell 命令 -> 直接跑
  3. 若写了脚本文件 (.cjs/.js/.py/.ps1/.sh)，用对应解释器运行
  4. 复制输出到剪贴板（若开启）
识别为 patch- 开头时，自动切到 Patch Tab 并选中。

═══ 设置项 ═══
- 工作目录: 所有操作默认在此执行
- 字体: 字体族 / 字号(文本区) / UI 字号(按钮标签)
- Python 解释器: 留空=自动探测（项目 venv > PATH > sys.executable）
- 脚本运行后自动执行验证: 跑完脚本是否跟一条验证命令
- 每次执行后自动复制输出到剪贴板
- 智能运行源: input_first / clipboard_first / ask
所有设置改动即生效，无需点"应用"（字体有应用按钮可选）。

═══ 自动识别验证命令 ═══
根据工作目录里的项目文件自动选：
  package.json        -> npm run typecheck
  Cargo.toml          -> cargo check
  go.mod              -> go build ./...
  pytest.ini / pyproject.toml / setup.py  -> pytest -q
  pom.xml             -> mvn -q compile
  build.gradle        -> gradle build -q
未识别时回退到 npm run typecheck。

═══ Python 解释器探测顺序 ═══
  1. 设置里的"Python 路径"（手动指定）
  2. 项目 venv: <work_dir>/.venv 或 venv 或 env 下的 python
  3. 环境变量 DEVTOOL_PYTHON
  4. PATH 里的 python / python3 / py
  5. 兜底: 运行 devtool 的 Python

═══ 配置文件 ═══
devtool-config.json（在 devtool.py 旁边）
字段: work_dir / font_family / font_size / ui_font_size / python_path /
      source_pref / auto_typecheck / copy_after_run / verify_cmd /
      window_geometry / paned_pos / paned_total
删除它 = 恢复所有默认值。

═══ 输出颜色 ═══
  $ 命令 / [shell(psh)]  蓝色
  [exit 0] / 完成(0失败) / ✓ 操作成功  绿色
  [exit 非0] / ❌ 失败 / 完成(有失败)  红色
  ⚠ 警告                黄色
  [源: ...]             青色

═══ 界面 ═══
- 主区和输出框之间有分隔条，可拖动调整高度（位置自动保存）
- 输出框可拖大拖小，输出区上方有 [复制全部] [清空] 按钮
- 窗口大小和位置下次启动自动恢复

═══ 给 AI 协作的约定 ═══
1. patch 脚本名 patch-*.{cjs,js,py,ps1,sh}
2. 幂等: 锚点存在就跳过
3. 处理 CRLF: split 时用 /\\r?\\n/
4. 输出 UTF-8 无 BOM
5. 完成后给用户明确的 commit message
6. 改 devtool.py 前先备份 devtool_bak.py，改完跑 ast.parse 检查语法
"""

DEFAULT_WORK_DIR = ROOT


def _default_cfg():
    return {
        "work_dir": DEFAULT_WORK_DIR,
        "auto_typecheck": True,
        "verify_cmd": "npm run typecheck",
        "patch_pattern": "patch-*.cjs",
        "copy_after_run": True,
        "smart_recognize": True,
    }


def _load_cfg():
    cfg = _default_cfg()
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            cfg.update(data)
    except Exception:
        pass
    return cfg

def _auto_verify_cmd(d):
    if not d:
        return ""
    import os as _os
    def has(name): return _os.path.exists(_os.path.join(d, name))
    if has("package.json"):
        return "npm run typecheck"
    if has("Cargo.toml"):
        return "cargo check"
    if has("go.mod"):
        return "go build ./..."
    if has("pytest.ini") or has("pyproject.toml") or has("setup.py"):
        return "pytest -q"
    if has("requirements.txt"):
        return "python -m py_compile"
    if has("pom.xml"):
        return "mvn -q compile"
    if has("build.gradle") or has("build.gradle.kts"):
        return "gradle build -q"
    return ""


def _verify_cmd_parts(cfg=None):
    import shlex
    if cfg is None:
        cfg = _load_cfg()
    cmd = (cfg.get("verify_cmd") or "").strip()
    if not cmd:
        cmd = _auto_verify_cmd(cfg.get("work_dir") or DEFAULT_WORK_DIR)
    if not cmd:
        cmd = "npm run typecheck"
    try:
        parts = shlex.split(cmd, posix=False)
    except Exception:
        parts = cmd.split()
    return parts or ["npm", "run", "typecheck"]

def _save_cfg(cfg):
    try:
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
    except Exception:
        pass

class App:
    def __init__(self, root):
        self.root = root
        root.title("DevTool")
        root.geometry("1060x820")
        root.minsize(880, 640)

        _geo = _load_cfg().get("window_geometry")
        if _geo:
            try:
                root.geometry(_geo)
            except Exception:
                pass
        root.protocol("WM_DELETE_WINDOW", self._on_close)

        self._cfg = _load_cfg()
        self.work_dir = self._cfg.get("work_dir") or DEFAULT_WORK_DIR
        if not os.path.isdir(self.work_dir):
            self.work_dir = DEFAULT_WORK_DIR

        apply_dark_theme(root)

        top = ttk.Frame(root)
        top.grid(row=0, column=0, sticky="ew", padx=12, pady=(10, 0))
        self.status_var = tk.StringVar(value="就绪")
        ttk.Label(top, textvariable=self.status_var, foreground=FG_MUTED).pack(side="left")

        self.nb = ttk.Notebook(root)
        # 上下可拖拽面板
        self._main_paned = tk.PanedWindow(root, orient="vertical",
                                    sashwidth=6, sashrelief="flat",
                                    bg="#1c1c1c", bd=0)
        self._main_paned.grid(row=1, column=0, sticky="nsew", padx=12, pady=(6, 4))
        root.grid_rowconfigure(1, weight=1)
        root.grid_columnconfigure(0, weight=1)
        self.nb = ttk.Notebook(self._main_paned)
        self._main_paned.add(self.nb, stretch="never", minsize=200)

        self.tab_files = ttk.Frame(self.nb)
        self.tab_patch = ttk.Frame(self.nb)
        # 顺序：文件操作 在 左，Patch 在 右
        self.nb.add(self.tab_files, text="  文件操作  ")
        self.nb.add(self.tab_patch, text="  Patch & Commit  ")
        self.tab_help = ttk.Frame(self.nb)
        self.tab_settings = ttk.Frame(self.nb)
        self.nb.add(self.tab_settings, text="  设置  ")
        self.nb.add(self.tab_help, text="  帮助  ")

        self._build_files_tab()
        self._build_patch_tab()
        self._build_settings_tab()
        self._build_help_tab()

        out = ttk.LabelFrame(self._main_paned, text="输出", padding=8)
        self._main_paned.add(out, stretch="never", minsize=100)


        self.output = tk.Text(
            out, wrap="word", font=("Consolas", 10),
            bg=BG_ENTRY, fg=FG, insertbackground=FG,
            selectbackground=ACCENT, selectforeground=BG,
            relief="flat", borderwidth=0,
        )
        self.output.pack(fill="both", expand=True)
        def _output_wheel(e):
            self.output.yview_scroll(int(-e.delta / 120), "units")
            return "break"
        self.output.bind("<MouseWheel>", _output_wheel)
        self._setup_output_tags()

        bar = ttk.Frame(out)
        _copy_btn = ttk.Button(bar, text="📋 复制全部输出", command=self.copy_all)
        _copy_btn.pack(side="right")
        _clear_btn = ttk.Button(bar, text="🗑 清空", command=self.clear_log)
        _clear_btn.pack(side="right", padx=6)

        def _show_bar(e=None):
            try:
                bar.place(relx=1.0, rely=0.0, anchor="ne", x=-10, y=10)
            except Exception:
                pass
        def _hide_bar(e=None):
            try:
                bar.place_forget()
            except Exception:
                pass
        out.bind("<Enter>", _show_bar)
        out.bind("<Leave>", _hide_bar)
        self.output.bind("<Enter>", _show_bar)
        self.output.bind("<Leave>", _hide_bar)
        _copy_btn.bind("<Enter>", _show_bar)
        _copy_btn.bind("<Leave>", _hide_bar)
        _clear_btn.bind("<Enter>", _show_bar)
        _clear_btn.bind("<Leave>", _hide_bar)

        self._apply_font()


        self._restore_paned()

        self.log("DevTool 就绪\n")

    # ================= Patch Tab =================
    def _build_patch_tab(self):
        f1 = ttk.LabelFrame(self.tab_patch, text="① Patch 脚本", padding=10)
        f1.pack(fill="x", padx=12, pady=(12, 4))

        self.patch_var = tk.StringVar()
        self.patch_combo = ttk.Combobox(f1, textvariable=self.patch_var, width=42, state="readonly")
        self.patch_combo.pack(side="left", padx=(0, 6))
        ttk.Button(f1, text="🔄 刷新", command=self.refresh_patches, width=8).pack(side="left", padx=2)
        ttk.Button(f1, text="▶ 运行 Patch", command=self.run_patch, width=12).pack(side="left", padx=2)
        ttk.Button(f1, text="🔍 Typecheck", command=self.run_typecheck, width=12).pack(side="left", padx=2)

        f2 = ttk.LabelFrame(self.tab_patch, text="② 提交", padding=10)
        f2.pack(fill="x", padx=12, pady=4)
        ttk.Label(f2, text="Commit 信息:").pack(side="left")
        self.msg_var = tk.StringVar()
        tk.Entry(f2, textvariable=self.msg_var, bg=BG_ENTRY, fg=FG, insertbackground=FG, relief="flat", borderwidth=0, highlightthickness=1, highlightbackground=LINE, highlightcolor=ACCENT).pack(side="left", padx=6, fill="x", expand=True)
        ttk.Button(f2, text="📝 提交", command=self.run_commit, width=10).pack(side="left", padx=2)
        ttk.Button(f2, text="📊 状态", command=self.run_status, width=10).pack(side="left", padx=2)

        f3 = ttk.LabelFrame(self.tab_patch, text="③ 一键流程", padding=10)
        f3.pack(fill="x", padx=12, pady=4)
        ttk.Button(f3, text="▶ Patch + Typecheck",
                   command=self.run_all_patch_check, width=26).pack(side="left", padx=4)
        ttk.Button(f3, text="🚀 智能运行",
                   command=lambda: self.smart_run("patch"), width=18).pack(side="left", padx=6)

        self.refresh_patches()

    # ================= 设置 Tab =================
    def _build_settings_tab(self):
        outer = ttk.Frame(self.tab_settings)
        outer.pack(fill="both", expand=True)
        canvas = tk.Canvas(outer, bg=BG, highlightthickness=0, bd=0)
        canvas.pack(side="left", fill="both", expand=True)
        f = ttk.Frame(canvas)
        _win = canvas.create_window((0, 0), window=f, anchor="nw")

        _state = {"last_w": 0, "busy": False}
        def _sync(e=None):
            if _state["busy"]:
                return
            _state["busy"] = True
            try:
                w = canvas.winfo_width()
                if w > 1 and _state["last_w"] != w:
                    _state["last_w"] = w
                    canvas.itemconfigure(_win, width=w)
                bbox = canvas.bbox("all")
                if bbox:
                    canvas.configure(scrollregion=bbox)
            finally:
                _state["busy"] = False
        canvas.bind("<Configure>", _sync)
        f.bind("<Configure>", _sync)

        def _wheel(e):
            try:
                canvas.yview_scroll(int(-e.delta / 120), "units")
            except Exception:
                pass
            return "break"

        def _bind_wheel(widget):
            try:
                widget.bind("<MouseWheel>", _wheel)
            except Exception:
                pass
            for child in widget.winfo_children():
                _bind_wheel(child)

        g1 = ttk.LabelFrame(f, text="工作目录", padding=10)
        g1.pack(fill="x", pady=(0, 10))
        row1 = ttk.Frame(g1)
        row1.pack(fill="x")
        self.work_dir_var = tk.StringVar(value=self.work_dir)
        _wde = tk.Entry(row1, textvariable=self.work_dir_var, bg=BG_ENTRY, fg=FG, insertbackground=FG, relief="flat", borderwidth=0, highlightthickness=1, highlightbackground=LINE, highlightcolor=ACCENT)
        _wde.pack(side="left", fill="x", expand=True, padx=(0, 6))
        _wde.bind("<Return>", lambda e: self._apply_work_dir())
        _wde.bind("<FocusOut>", lambda e: self._apply_work_dir())
        ttk.Button(row1, text="浏览", command=self._browse_work_dir, width=10).pack(side="left")
        ttk.Label(g1, text="所有文件操作、脚本运行、shell 命令默认在此目录下执行。", foreground=FG_MUTED).pack(anchor="w", pady=(6, 0))

        gFont = ttk.LabelFrame(f, text="字体", padding=10)
        gFont.pack(fill="x", pady=(0, 10))
        rowF = ttk.Frame(gFont)
        rowF.pack(fill="x")
        ttk.Label(rowF, text="字体族:").pack(side="left")
        self.font_family_var = tk.StringVar(value=self._cfg.get("font_family", "Consolas"))
        _fe = tk.Entry(rowF, textvariable=self.font_family_var, width=22, bg=BG_ENTRY, fg=FG, insertbackground=FG, relief="flat", borderwidth=0, highlightthickness=1, highlightbackground=LINE, highlightcolor=ACCENT)
        _fe.pack(side="left", padx=(6, 16))
        ttk.Label(rowF, text="字号:").pack(side="left")
        self.font_size_var = tk.StringVar(value=str(self._cfg.get("font_size", 10)))
        _fse = ttk.Spinbox(rowF, from_=8, to=32, textvariable=self.font_size_var, width=6)
        _fse.pack(side="left", padx=6)
        ttk.Label(rowF, text="UI 字号:").pack(side="left")
        self.ui_font_size_var = tk.StringVar(value=str(self._cfg.get("ui_font_size", 9)))
        _fue = ttk.Spinbox(rowF, from_=7, to=20, textvariable=self.ui_font_size_var, width=5)
        _fue.pack(side="left", padx=6)
        _fue.bind("<Return>", lambda e: self._apply_font())
        _fue.bind("<FocusOut>", lambda e: self._apply_font())
        _fe.bind("<Return>", lambda e: self._apply_font())
        _fe.bind("<FocusOut>", lambda e: self._apply_font())
        _fse.bind("<Return>", lambda e: self._apply_font())
        _fse.bind("<FocusOut>", lambda e: self._apply_font())
        ttk.Button(rowF, text="应用", command=self._apply_font, width=8).pack(side="left", padx=(16, 0))
        ttk.Label(gFont, text="应用到所有输出区、JSON 输入区。", foreground=FG_MUTED).pack(anchor="w", pady=(6, 0))

        gPy = ttk.LabelFrame(f, text="Python 解释器", padding=10)
        gPy.pack(fill="x", pady=(0, 10))
        rowPy = ttk.Frame(gPy)
        rowPy.pack(fill="x")
        ttk.Label(rowPy, text="路径:").pack(side="left")
        self.py_path_var = tk.StringVar(value=self._cfg.get("python_path", ""))
        _pe2 = tk.Entry(rowPy, textvariable=self.py_path_var, width=48, bg=BG_ENTRY, fg=FG, insertbackground=FG, relief="flat", borderwidth=0, highlightthickness=1, highlightbackground=LINE, highlightcolor=ACCENT)
        _pe2.pack(side="left", padx=6, fill="x", expand=True)
        _pe2.bind("<Return>", lambda e: self._apply_python_path())
        _pe2.bind("<FocusOut>", lambda e: self._apply_python_path())
        ttk.Label(gPy, text="留空=自动探测（项目 venv > PATH > sys.executable）", foreground=FG_MUTED).pack(anchor="w", pady=(6, 0))

        g2 = ttk.LabelFrame(f, text="行为", padding=10)
        g2.pack(fill="x", pady=(0, 10))
        self.auto_tc_var = tk.BooleanVar(value=self._cfg.get("auto_typecheck", True))
        ttk.Checkbutton(g2, text="脚本运行后自动执行验证", variable=self.auto_tc_var,
                        command=lambda: self._save_setting("auto_typecheck", bool(self.auto_tc_var.get()))
                        ).pack(anchor="w", pady=2)
        self.copy_after_var = tk.BooleanVar(value=self._cfg.get("copy_after_run", True))
        ttk.Checkbutton(g2, text="每次执行后自动复制输出到剪贴板", variable=self.copy_after_var,
                        command=lambda: self._save_setting("copy_after_run", bool(self.copy_after_var.get()))
                        ).pack(anchor="w", pady=2)

        rowSrc = ttk.Frame(g2)
        rowSrc.pack(anchor="w", pady=(6, 2))
        ttk.Label(rowSrc, text="智能运行源:").pack(side="left")
        self.source_pref_var = tk.StringVar(value=self._cfg.get("source_pref", "input_first"))
        self.source_pref_combo = ttk.Combobox(rowSrc, textvariable=self.source_pref_var, width=18, state="readonly")
        self.source_pref_combo["values"] = ("input_first", "clipboard_first", "ask")
        self.source_pref_combo.pack(side="left", padx=6)
        self.source_pref_combo.bind("<<ComboboxSelected>>", lambda e: self._apply_source_pref())
        ttk.Label(g2, text="input_first=输入框优先 / clipboard_first=剪贴板优先 / ask=每次询问", foreground=FG_MUTED).pack(anchor="w", pady=(2, 0))

        _auto = _auto_verify_cmd(self.work_dir)
        ttk.Label(f, text="自动识别的验证命令: " + (_auto or "(未识别，将回退到 npm run typecheck)"), foreground=FG_MUTED).pack(anchor="w", pady=(6, 0))
        ttk.Label(f, text="配置文件: " + CONFIG_FILE, foreground=FG_MUTED).pack(anchor="w", pady=(2, 0))

        # 递归绑定滚轮
        _bind_wheel(f)


    def _browse_work_dir(self):
        from tkinter import filedialog
        cur = self.work_dir_var.get() or self.work_dir
        d = filedialog.askdirectory(initialdir=cur, title="选择工作目录")
        if d:
            self.work_dir_var.set(d)

    def _apply_work_dir(self):
        d = self.work_dir_var.get().strip()
        if not d or not os.path.isdir(d):
            messagebox.showwarning("提示", "目录不存在: " + d)
            return
        self.work_dir = d
        self._cfg["work_dir"] = d
        self._save_setting("work_dir", d)
        self.refresh_patches()
        self.set_status("工作目录已切换到: " + d)
        self.log("工作目录: " + d + "\n")

    def _apply_font(self):
        fam = (self.font_family_var.get() or "Consolas").strip()
        try:
            size = int(self.font_size_var.get())
        except Exception:
            size = 10
        if size < 8 or size > 32:
            size = 10
        try:
            ui_size = int(self.ui_font_size_var.get())
        except Exception:
            ui_size = 9
        if ui_size < 7 or ui_size > 20:
            ui_size = 9

        self._cfg["font_family"] = fam
        self._cfg["font_size"] = size
        self._cfg["ui_font_size"] = ui_size
        self._save_setting("font_family", fam)
        self._save_setting("font_size", size)
        self._save_setting("ui_font_size", ui_size)

        # ttk 控件：按钮/标签/输入框/Notebook 页签 全部用 UI 字号
        style = ttk.Style()
        for name in ("TButton", "TLabel", "TEntry", "TCombobox", "TSpinbox",
                     "TCheckbutton", "TRadiobutton", "TNotebook.Tab",
                     "TLabelframe.Label", "TFrame"):
            try:
                style.configure(name, font=(fam, ui_size))
            except Exception:
                pass

        # Tk 默认字体
        import tkinter.font as _tkfont
        for fname in ("TkDefaultFont", "TkTextFont", "TkMenuFont", "TkHeadingFont"):
            try:
                f = _tkfont.nametofont(fname)
                f.configure(family=fam, size=ui_size)
            except Exception:
                pass

        # 文本区（输出/输入）用 size
        self._apply_font_recursive(self.root, fam, size)

        self.set_status("字体: " + fam + " UI=" + str(ui_size) + " 文本=" + str(size))
        self.log("字体: " + fam + " UI=" + str(ui_size) + " 文本=" + str(size) + "\n")

    def _apply_python_path(self):
        v = (self.py_path_var.get() or "").strip()
        self._cfg["python_path"] = v
        self._save_setting("python_path", v)
        actual = _find_python(self.work_dir, v or None)
        self.set_status("Python: " + actual)
        self.log("Python: " + actual + "\n")

    def _apply_source_pref(self):
        v = self.source_pref_var.get()
        if v not in ("input_first", "clipboard_first", "ask"):
            v = "input_first"
        self._cfg["source_pref"] = v
        self._save_setting("source_pref", v)
        self.set_status("智能运行源已设为: " + v)

    def _apply_font_recursive(self, widget, fam, size):
        try:
            if isinstance(widget, tk.Text):
                widget.configure(font=(fam, size))
        except Exception:
            pass
        for child in widget.winfo_children():
            self._apply_font_recursive(child, fam, size)

    # ================= 帮助 Tab =================
    def _build_help_tab(self):
        f = ttk.Frame(self.tab_help)
        f.pack(fill="both", expand=True, padx=12, pady=12)

        # 无滚动条的 Text（鼠标滚轮滚动）
        txt = tk.Text(
            f, wrap="char", font=("Consolas", 10),
            bg=BG_ENTRY, fg=FG, insertbackground=FG,
            selectbackground=ACCENT, selectforeground=BG,
            relief="flat", borderwidth=0,
        )
        txt.pack(fill="both", expand=True)
        txt.insert("1.0", HELP_TEXT)
        txt.configure(state="disabled")

        def _on_wheel(e):
            txt.yview_scroll(int(-e.delta / 120), "units")
            return "break"
        txt.bind("<MouseWheel>", _on_wheel)

        copy_btn = ttk.Button(f, text="📋 复制全部帮助", command=self._copy_help_all)

        def _show(e=None):
            copy_btn.place(relx=1.0, rely=0.0, anchor="ne", x=-20, y=20)
        def _hide(e=None):
            copy_btn.place_forget()

        txt.bind("<Enter>", _show)
        txt.bind("<Leave>", _hide)
        copy_btn.bind("<Enter>", _show)
        copy_btn.bind("<Leave>", _hide)

    def _copy_help_all(self):
        self.root.clipboard_clear()
        self.root.clipboard_append(HELP_TEXT)
        self.set_status("已复制帮助内容到剪贴板")

    def _build_files_tab(self):
        info = ttk.Label(
            self.tab_files,
            text="粘贴 JSON 数组（点『示例』看格式）。支持的操作：\n"
                 "  write   覆盖写入      {op:'write',  path:'...', content:'...'}\n"
                 "  append  追加到末尾    {op:'append', path:'...', content:'...'}\n"
                 "  delete  删除文件/目录  {op:'delete', path:'...'}\n"
                 "  mkdir   创建目录      {op:'mkdir',  path:'...'}",
            justify="left", foreground=FG_MUTED,
        )
        info.pack(fill="x", padx=12, pady=(12, 4))


        bottom = ttk.Frame(self.tab_files)
        bottom.pack(fill="x", padx=12, pady=(4, 8))
        ttk.Button(bottom, text="▶ 执行文件操作",
                   command=self.run_file_ops, width=20).pack(side="left", padx=2)
        ttk.Button(bottom, text="🚀 智能运行",
                   command=lambda: self.smart_run("files"), width=18).pack(side="left", padx=6)

        input_wrap = ttk.Frame(self.tab_files)
        input_wrap.pack(fill="both", expand=True, padx=12, pady=6)

        self.ops_text = tk.Text(
            input_wrap, height=16, wrap="word", font=("Consolas", 10),
            bg=BG_ENTRY, fg=FG, insertbackground=FG,
            selectbackground=ACCENT, selectforeground=BG,
            relief="flat", borderwidth=0,
        )
        self.ops_text.pack(fill="both", expand=True)

        def _ops_wheel(e):
            self.ops_text.yview_scroll(int(-e.delta / 120), "units")
            return "break"
        self.ops_text.bind("<MouseWheel>", _ops_wheel)

        hover = ttk.Frame(input_wrap)
        _paste_btn = ttk.Button(hover, text="📋 粘贴剪贴板",
                                command=self.paste_from_clipboard)
        _paste_btn.pack(side="left", padx=(0, 6))
        _clear_btn = ttk.Button(hover, text="🗑 清空",
                                command=lambda: self.ops_text.delete("1.0", "end"))
        _clear_btn.pack(side="left")

        def _show_ops_bar(e=None):
            try:
                hover.place(relx=1.0, rely=0.0, anchor="ne", x=-10, y=10)
            except Exception:
                pass
        def _hide_ops_bar(e=None):
            try:
                hover.place_forget()
            except Exception:
                pass
        self.ops_text.bind("<Enter>", _show_ops_bar)
        self.ops_text.bind("<Leave>", _hide_ops_bar)
        _paste_btn.bind("<Enter>", _show_ops_bar)
        _paste_btn.bind("<Leave>", _hide_ops_bar)
        _clear_btn.bind("<Enter>", _show_ops_bar)
        _clear_btn.bind("<Leave>", _hide_ops_bar)

    def log(self, text):
        def _do():
            txt = text if text.endswith("\n") else (text + "\n")
            parts = txt.split("\n")
            for raw in parts[:-1]:
                tag = self._line_tag(raw)
                self.output.insert("end", raw + "\n", tag)
            self.output.see("end")
        self.root.after(0, _do)

    def _setup_output_tags(self):
        cfg = {
            "t_default": FG,
            "t_muted":   FG_MUTED,
            "t_cmd":     "#79b8ff",
            "t_ok":      OK,
            "t_err":     DANGER,
            "t_warn":    WARN,
            "t_accent":  ACCENT,
        }
        for name, fg in cfg.items():
            self.output.tag_configure(name, foreground=fg)

    def _line_tag(self, line):
        l = line.rstrip()
        if not l:
            return "t_default"
        # 完成行: N 成功, M 失败 -> 整行按是否有失败着色
        import re as _re
        m = _re.match(r"^完成:\s*(\d+)\s*成功,\s*(\d+)\s*失败", l)
        if m:
            return "t_ok" if m.group(2) == "0" else "t_err"
        # 文件操作单行: [N] op  ✓ path -> 绿色
        m2 = _re.match(r"^\[\d+\]\s+(write|append|delete|mkdir|shell)", l)
        if m2 and ("\u2713" in l or "ok" in l.lower()):
            return "t_ok"
        m3 = _re.match(r"^\[\d+\].*\u274c", l)
        if m3:
            return "t_err"
        if l.startswith("$ "):
            return "t_cmd"
        if l.startswith("[exit 0]"):
            return "t_ok"
        if l.startswith("[exit "):
            return "t_err"
        if "\u2705" in l:
            return "t_ok"
        if "\u274c" in l or l.startswith("[\u9519\u8bef]"):
            return "t_err"
        if "\u26a0" in l:
            return "t_warn"
        if l.startswith("[\u6e90:"):
            return "t_accent"
        if l.startswith("["):
            return "t_muted"
        return "t_default"

    def clear_log(self):
        self.output.delete("1.0", "end")

    def paste_from_clipboard(self):
        try:
            content = self.root.clipboard_get()
        except Exception:
            self.set_status("剪贴板为空或不可读")
            return
        if not isinstance(content, str):
            content = str(content)
        self.ops_text.delete("1.0", "end")
        self.ops_text.insert("1.0", content)
        self.set_status("已粘贴剪贴板内容（" + str(len(content)) + " 字符）")

    def _get_clipboard(self):
        try:
            content = self.root.clipboard_get()
        except Exception:
            return None
        if not isinstance(content, str):
            content = str(content)
        return content

    def _extract_json_blocks(self, text):
        parts = text.split("```")
        results = []
        i = 1
        while i < len(parts):
            block = parts[i]
            if block.startswith("json"):
                block = block[4:]
            block = block.strip()
            try:
                data = json.loads(block)
                if isinstance(data, list):
                    results.append(data)
            except Exception:
                pass
            i += 2
        return results

    def _try_parse_ops_json(self, text):
        s = text.strip()
        if not s.startswith("["):
            return None
        try:
            data = json.loads(s)
            if isinstance(data, list):
                return data
        except Exception:
            pass
        return None

    def _find_patch_name(self, text):
        idx = text.find("patch-")
        if idx < 0:
            return None
        end_py = text.find(".py", idx)
        end_cjs = text.find(".cjs", idx)
        if end_py < 0 and end_cjs < 0:
            return None
        if end_py < 0:
            end, ext_len = end_cjs, 4
        elif end_cjs < 0:
            end, ext_len = end_py, 3
        elif end_py < end_cjs:
            end, ext_len = end_py, 3
        else:
            end, ext_len = end_cjs, 4
        candidate = text[idx:end + ext_len]
        for ch in candidate:
            if ch in " " + chr(9) + chr(13) + chr(10):
                return None
        return candidate

    def _try_parse_shell_lines(self, text):
        s = text.strip()
        if not s or len(s) > 4000:
            return None
        if chr(96) * 3 in s:
            return None
        lines = [l.strip() for l in s.split(chr(10))]
        lines = [l for l in lines if l]
        if not lines or len(lines) > 20:
            return None
        known = {"npm", "npx", "node", "python", "python3", "py", "git",
                 "dir", "type", "findstr", "echo", "del", "copy", "move",
                 "mkdir", "rmdir", "cd", "chdir", "powershell", "cmd",
                 "where", "taskkill", "cls", "attrib", "ren", "rename",
                 "start", "call", "set"}
        bad_start = ("{", "[", "#", "//", ">", "*", "|", "=", "<", "!")
        ops = []
        for l in lines:
            if l.startswith(bad_start):
                return None
            parts = l.split()
            if not parts:
                return None
            first = parts[0].lower()
            if first in known or _looks_like_powershell(l):
                ops.append({"op": "shell", "cmd": l})
            else:
                return None
        return ops

    def smart_run(self, source_tab):
        box = self.ops_text.get("1.0", "end").strip()
        clip = self._get_clipboard() or ""
        pref = self.source_pref_var.get()
        content = ""
        source_label = ""
        if pref == "clipboard_first":
            content = clip or box
            source_label = "剪贴板" if clip else ("输入框" if box else "")
        elif pref == "ask" and box and clip:
            from tkinter import messagebox as _mb
            ans = _mb.askyesnocancel("选择源", "输入框和剪贴板都有内容。\n\n是=用输入框\n否=用剪贴板\n取消=中止")
            if ans is None:
                self.set_status("已取消")
                return
            if ans:
                content = box
                source_label = "输入框"
            else:
                content = clip
                source_label = "剪贴板"
        else:
            content = box or clip
            source_label = "输入框" if box else ("剪贴板" if clip else "")
        if not content:
            self.set_status("输入框和剪贴板都为空")
            return
        self.log("[源: " + source_label + "]\n")
        self.set_status("源: " + source_label)
        ops = self._try_parse_ops_json(content)
        if ops is None:
            blocks = self._extract_json_blocks(content)
            if blocks:
                ops = blocks[0]
        patch_name = self._find_patch_name(content)
        if ops is not None:
            n = len(ops)
            self.set_status("识别为文件操作 JSON（" + str(n) + " 项），执行中...")
            self.ops_text.delete("1.0", "end")
            self.ops_text.insert("1.0", json.dumps(ops, ensure_ascii=False, indent=2))
            if source_tab != "files":
                self.nb.select(self.tab_files)
            self._auto_copy_after_run = True
            self.root.after(80, self.run_oneclick)
            return
        if patch_name:  # smart_run_patch_fixed
            self.set_status("识别 patch 脚本：" + patch_name + "，执行中...")
            self.refresh_patches()
            _vals = list(self.patch_combo["values"] or ())
            if patch_name not in _vals:
                self.clear_log()
                self.log("[智能运行] 未找到 patch 脚本：" + patch_name)
                self.log("")
                self.log("当前可用的 patch 脚本：")
                for _v in _vals:
                    self.log("  " + _v)
                self.log("")
                self.log("请确认文件名是否正确，或是否已写入项目根目录。")
                self.set_status("patch 脚本不存在：" + patch_name)
                return
            self.patch_var.set(patch_name)
            if source_tab != "patch":
                self.nb.select(self.tab_patch)
            self._auto_copy_after_run = True
            self.root.after(150, self.run_patch)
            return
        shell_ops = self._try_parse_shell_lines(content)
        if shell_ops:
            n = len(shell_ops)
            self.set_status("识别为 shell 命令（" + str(n) + " 条），执行中...")
            self.ops_text.delete("1.0", "end")
            self.ops_text.insert("1.0", json.dumps(shell_ops, ensure_ascii=False, indent=2))
            if source_tab != "files":
                self.nb.select(self.tab_files)
            self._auto_copy_after_run = True
            self.root.after(80, self.run_oneclick)
            return
        self.ops_text.delete("1.0", "end")
        self.ops_text.insert("1.0", content)
        if source_tab == "patch":
            self.nb.select(self.tab_files)
        self.clear_log()
        self.log("[智能运行] 未识别出明确指令，内容已填入输入框。")
        self.log("")
        self.log("支持以下三种输入格式：")
        self.log("  1. JSON 数组（含 ```json 代码块）")
        self.log("  2. patch-xxx.py 或 patch-xxx.cjs 文件名")
        self.log("  3. 多行 shell 命令（每行以已知命令词开头，如 git/npm/node）")
        self.log("")
        self.log("如要执行当前内容，请手动编辑为上述格式后点「▶ 执行文件操作」。")
        self.set_status("未识别出明确指令，已填入输入框")

    def copy_all(self):
        text = self.output.get("1.0", "end").rstrip()
        self.root.clipboard_clear()
        self.root.clipboard_append(text)
        messagebox.showinfo("复制", "输出已复制到剪贴板")

    def _copy_silent(self):
        text = self.output.get("1.0", "end").rstrip()
        self.root.clipboard_clear()
        self.root.clipboard_append(text)

    def set_status(self, t):
        self.root.after(0, lambda: self.status_var.set(t))

    def run_cmd(self, cmd, cwd=None):
        if cwd is None:
            cwd = self.work_dir
        if cmd:
            cmd = list(cmd)
            cmd[0] = _resolve_exe(cmd[0])
        self.log("$ " + " ".join(cmd))
        try:
            p = subprocess.run(
                cmd, cwd=cwd, capture_output=True, text=True,
                encoding="utf-8", errors="replace",
            )
            if p.stdout:
                self.log(p.stdout.rstrip())
            if p.stderr:
                self.log(p.stderr.rstrip())
            self.log(f"[exit {p.returncode}]\n")
            return p.returncode
        except Exception as e:
            self.log(f"[错误] {e}\n")
            return -1

    # ================= Patch 相关 =================
    def refresh_patches(self):
        EXCLUDE = {"devtool.py", "devtool_bak.py"}
        try:
            exts = (".cjs", ".js", ".py", ".ps1", ".sh")
            files = sorted(
                (f for f in os.listdir(self.work_dir)
                 if f.lower().endswith(exts)
                 and f not in EXCLUDE
                 and not f.endswith("_bak.py")),
                key=lambda f: f,
            )
        except OSError:
            files = []
        self.patch_combo["values"] = files
        if files and not self.patch_var.get():
            self.patch_var.set(files[0])

    def run_patch(self):
        name = self.patch_var.get().strip()
        if not name:
            return messagebox.showwarning("提示", "选择 patch 脚本")
        threading.Thread(target=self._bg_patch, args=(name,), daemon=True).start()

    def _bg_patch(self, name):
        self.clear_log()
        self.set_status("运行 patch...")
        c = self.run_cmd(_patch_cmd(name, self.work_dir, self._cfg.get("python_path")))
        self.log("✅ Patch 成功\n" if c == 0 else "❌ Patch 失败\n")
        self.set_status("patch 完成" if c == 0 else "patch 失败")
        if getattr(self, "_auto_copy_after_run", False):
            self._auto_copy_after_run = False
            self.root.after(80, self._copy_silent)
            self.set_status("patch 完成，输出已复制到剪贴板")
        if getattr(self, "auto_tc_var", None) is not None and self.auto_tc_var.get():
            self.root.after(200, self.run_typecheck)

    def _save_setting(self, key, value):
        cfg = _load_cfg()
        cfg[key] = value
        _save_cfg(cfg)

    def _save_paned(self):
        try:
            if hasattr(self, "_main_paned"):
                pos = self._main_paned.sash_coord(0)[1]
                h = self._main_paned.winfo_height()
                if pos > 0 and h > 0 and pos < h:
                    self._cfg["paned_pos"] = pos
                    self._cfg["paned_total"] = h
                    self._save_setting("paned_pos", pos)
                    self._save_setting("paned_total", h)
                    print("[paned] saved pos=" + str(pos) + " total=" + str(h))
        except Exception as e:
            print("[_save_paned]", e)

    def _restore_paned(self):
        pos = self._cfg.get("paned_pos")
        total = self._cfg.get("paned_total")
        print("[paned restore] cfg pos=" + str(pos) + " total=" + str(total))
        if not pos:
            return
        def _try(attempt=0):
            try:
                mapped = self._main_paned.winfo_ismapped()
                h_now = self._main_paned.winfo_height()
                if not mapped or h_now < 50:
                    if attempt < 20:
                        self.root.after(100, lambda: _try(attempt + 1))
                    return
                new_pos = int(pos)
                if total and total > 0:
                    new_pos = int(pos / total * h_now)
                if 80 <= new_pos <= h_now - 100:
                    self._main_paned.sash_place(0, 0, new_pos)
                    print("[paned] restored to " + str(new_pos))
                else:
                    print("[paned] skip new_pos=" + str(new_pos) + " range 80.." + str(h_now - 100))
            except Exception as e:
                print("[paned try err] " + str(e))
        self.root.after(400, lambda: _try(0))

    def _apply_paned_pos(self, pos):
        try:
            total = self._main_paned.winfo_height()
            if total <= 0 or pos < 80 or pos > total - 100:
                return
            self._main_paned.sashpos(0, pos)
        except Exception:
            pass

    def _on_close(self):
        try:
            self._save_setting("window_geometry", self.root.geometry())
        except Exception:
            pass
        try:
            self._save_paned()
        except Exception as e:
            print("[_on_close save_paned]", e)
        self.root.destroy()

    def _on_auto_tc_toggle(self):
        self._save_setting("auto_typecheck", bool(self.auto_tc_var.get()))

    def run_typecheck(self):
        threading.Thread(target=self._bg_typecheck, daemon=True).start()

    def _bg_typecheck(self):
        self.clear_log()
        self.set_status("typecheck...")
        c = self.run_cmd(_verify_cmd_parts(self._cfg))
        self.log("✅ Typecheck 通过\n" if c == 0 else "❌ Typecheck 失败\n")
        self.set_status("typecheck 通过" if c == 0 else "typecheck 失败")

    def run_status(self):
        threading.Thread(
            target=lambda: self.run_cmd(["git", "status", "--short"]),
            daemon=True,
        ).start()

    def run_commit(self):
        msg = self.msg_var.get().strip()
        if not msg:
            return messagebox.showwarning("提示", "输入 commit 信息")
        threading.Thread(target=self._bg_commit, args=(msg,), daemon=True).start()

    def _bg_commit(self, msg):
        self.clear_log()
        self.set_status("提交中...")
        if self.run_cmd(["git", "add", "-A"]) != 0:
            self.set_status("git add 失败")
            return
        if self.run_cmd(["git", "commit", "-m", msg]) != 0:
            self.log("⚠️ 提交失败\n")
            self.set_status("提交失败")
            return
        self.log("✅ 已提交\n")
        self.run_cmd(["git", "log", "--oneline", "-3"])
        self.set_status("提交成功")

    def run_all_patch_check(self):
        name = self.patch_var.get().strip()
        if not name:
            return messagebox.showwarning("提示", "选择 patch 脚本")
        threading.Thread(target=self._bg_patch_check, args=(name,), daemon=True).start()

    def _bg_patch_check(self, name):
        self.clear_log()
        self.set_status("Patch 中...")
        if self.run_cmd(_patch_cmd(name, self.work_dir, self._cfg.get("python_path"))) != 0:
            self.log("❌ Patch 失败\n")
            self.set_status("Patch 失败")
            return
        self.log("✅ Patch 成功\n\n")
        self.set_status("Typecheck 中...")
        if self.run_cmd(_verify_cmd_parts(self._cfg)) != 0:
            self.log("❌ Typecheck 失败\n")
            self.set_status("Typecheck 失败")
            return
        self.log("✅ Typecheck 通过\n\n")
        self.run_cmd(["git", "status", "--short"])
        self.set_status("Patch + Typecheck 通过")

    def run_full(self):
        name = self.patch_var.get().strip()
        msg = self.msg_var.get().strip()
        if not name:
            return messagebox.showwarning("提示", "选择 patch")
        if not msg:
            return messagebox.showwarning("提示", "输入 commit 信息")
        threading.Thread(target=self._bg_full, args=(name, msg), daemon=True).start()

    def _bg_full(self, name, msg):
        self.clear_log()
        self.set_status("① Patch...")
        if self.run_cmd(_patch_cmd(name, self.work_dir, self._cfg.get("python_path"))) != 0:
            self.log("❌ Patch 失败\n")
            return
        self.log("✅ Patch 成功\n\n")
        self.set_status("② Typecheck...")
        if self.run_cmd(_verify_cmd_parts(self._cfg)) != 0:
            self.log("❌ Typecheck 失败\n")
            return
        self.log("✅ Typecheck 通过\n\n")
        self.set_status("③ git add...")
        if self.run_cmd(["git", "add", "-A"]) != 0:
            self.log("❌ git add 失败\n")
            return
        self.set_status("④ git commit...")
        if self.run_cmd(["git", "commit", "-m", msg]) != 0:
            self.log("❌ 提交失败\n")
            return
        self.log("✅ 已提交\n")
        self.run_cmd(["git", "log", "--oneline", "-3"])
        self.set_status("🎉 全部完成")

    # ================= 文件操作相关 =================
    def load_example(self):
        example = json.dumps([
            {"op": "write", "path": "src/example.ts", "content": "export const X = 1;\n"},
            {"op": "append", "path": "src/example.ts", "content": "export const Y = 2;\n"},
            {"op": "delete", "path": "patch-temp.cjs"},
            {"op": "mkdir", "path": "src/newdir"},
        ], indent=2, ensure_ascii=False)
        self.ops_text.delete("1.0", "end")
        self.ops_text.insert("1.0", example)

    def load_devtasks(self):
        p = os.path.join(self.work_dir, "devtasks.json")
        if not os.path.exists(p):
            return messagebox.showwarning("提示", "找不到 devtasks.json")
        try:
            with open(p, "r", encoding="utf-8") as f:
                self.ops_text.delete("1.0", "end")
                self.ops_text.insert("1.0", f.read())
            self.log("已加载 devtasks.json\n")
        except Exception as e:
            messagebox.showerror("错误", str(e))

    def run_file_ops(self):
        threading.Thread(target=self._bg_file_ops, daemon=True).start()

    def _bg_file_ops(self):
        self.clear_log()  # bg_file_ops_clear_log_fixed
        raw = self.ops_text.get("1.0", "end").strip()
        if not raw:
            return self.root.after(0, lambda: messagebox.showwarning("提示", "JSON 为空"))
        try:
            tasks = json.loads(raw)
        except Exception as e:
            self.log(f"[JSON 解析失败] {e}")
            self.log("")
            self.log("提示：输入框内容不是合法 JSON。三种用法：")
            self.log("  1. JSON 数组: [{\"op\":\"write\",\"path\":\"...\",\"content\":\"...\"}]")
            self.log("  2. 纯 shell 命令: 用「🚀 智能运行」自动识别")
            self.log("  3. 只运行脚本: 用「🚀 智能运行」")
            return
        if not isinstance(tasks, list):
            self.log("[错误] 顶层应为数组\n")
            return
        self.set_status("执行文件操作...")
        ok, fail = self._exec_tasks(tasks)
        self.log(f"\n完成: {ok} 成功, {fail} 失败\n")
        self.set_status(f"{ok} 成功 / {fail} 失败")
        if getattr(self, "copy_after_var", None) and self.copy_after_var.get():
            self.root.after(0, self._copy_silent)
        if getattr(self, "_auto_copy_after_run", False):
            self._auto_copy_after_run = False
            self.root.after(80, self._copy_silent)
            self.set_status("文件操作完成，输出已复制到剪贴板")

    def _exec_tasks(self, tasks):
        ok, fail = 0, 0
        for i, t in enumerate(tasks, 1):
            try:
                op = t.get("op")
                path = t.get("path", "")
                full = os.path.join(self.work_dir, path)
                if op == "write":
                    d = os.path.dirname(full)
                    if d:
                        os.makedirs(d, exist_ok=True)
                    with open(full, "w", encoding="utf-8", newline="") as f:
                        f.write(t.get("content", ""))
                    self.log(f"[{i}] write  ✓ {path}")
                elif op == "append":
                    d = os.path.dirname(full)
                    if d:
                        os.makedirs(d, exist_ok=True)
                    with open(full, "a", encoding="utf-8", newline="") as f:
                        f.write(t.get("content", ""))
                    self.log(f"[{i}] append ✓ {path}")
                elif op == "delete":
                    if os.path.exists(full):
                        if os.path.isdir(full):
                            shutil.rmtree(full)
                        else:
                            os.remove(full)
                        self.log(f"[{i}] delete ✓ {path}")
                    else:
                        self.log(f"[{i}] delete ⚠ 不存在: {path}")
                elif op == "mkdir":
                    os.makedirs(full, exist_ok=True)
                    self.log(f"[{i}] mkdir  ✓ {path}")
                elif op == "shell":
                    cmd = t.get("cmd", "")
                    if not cmd:
                        raise ValueError("empty cmd")
                    cmd = _rewrite_shell_cmd(cmd)
                    use_psh = _looks_like_powershell(cmd)
                    self.log(f"[{i}] shell({('psh' if use_psh else 'cmd')})  $ {cmd}")
                    try:
                        if use_psh:
                            sp = subprocess.run(
                                ["powershell", "-NoProfile", "-Command", cmd],
                                cwd=self.work_dir, capture_output=True,
                                text=True, encoding="utf-8", errors="replace",
                            )
                        else:
                            sp = subprocess.run(
                                cmd, cwd=self.work_dir, shell=True, capture_output=True,
                                text=True, encoding="utf-8", errors="replace",
                            )
                    except Exception as e:
                        self.log(f"[\u274c] {e}")
                        fail += 1
                        continue
                    if sp.stdout:
                        self.log(sp.stdout.rstrip())
                    if sp.stderr:
                        self.log(sp.stderr.rstrip())
                    self.log(f"[exit {sp.returncode}]")
                    if sp.returncode != 0:
                        fail += 1
                        continue
                else:
                    self.log(f"[{i}] ⚠ 未知 op: {op}")
                    fail += 1
                    continue
                ok += 1
            except Exception as e:
                self.log(f"[{i}] ❌ {path}: {e}")
                fail += 1
        return ok, fail


    def run_oneclick(self):
        threading.Thread(target=self._bg_oneclick, daemon=True).start()

    def _bg_oneclick(self):
        raw = self.ops_text.get("1.0", "end").strip()
        if not raw:
            return self.root.after(0, lambda: messagebox.showwarning("提示", "JSON 为空"))
        try:
            tasks = json.loads(raw)
        except Exception as e:
            self.log(f"[JSON 解析失败] {e}\n")
            return
        if not isinstance(tasks, list):
            self.log("[错误] 顶层应为数组\n")
            return

        self.clear_log()

        # ① 文件操作
        self.set_status("① 文件操作...")
        ok, fail = self._exec_tasks(tasks)
        self.log(f"\n文件操作: {ok} 成功 / {fail} 失败\n\n")

        # 识别可运行文件（扫描所有 write）
        runnable = self._pick_runnable(tasks)

        if not runnable:
            self.log("⚠ 未识别出可运行的脚本（.cjs/.js/.py/.ps1/.sh），跳过执行\n")
            if getattr(self, "copy_after_var", None) and self.copy_after_var.get():
                self.root.after(0, self._copy_silent)
            self.set_status("文件操作完成（无可运行脚本），已复制")
            return

        kind, name = runnable

        if kind == "patch":
            # 切到 patch tab + 刷新 + 选中
            self.set_status("② 切换到 Patch tab: " + name)
            def _switch():
                self.nb.select(self.tab_patch)
                self.refresh_patches()
                values = self.patch_combo["values"] or ()
                if name in values:
                    self.patch_var.set(name)
            self.root.after(0, _switch)
            time.sleep(0.15)
            self.set_status("③ 运行 patch: " + name)
            if self.run_cmd(_patch_cmd(name, self.work_dir, self._cfg.get("python_path"))) != 0:
                self.log("❌ " + name + " 运行失败\n")
                if getattr(self, "copy_after_var", None) and self.copy_after_var.get():
                    self.root.after(0, self._copy_silent)
                self.set_status(name + " 运行失败")
                return
            self.log("✅ " + name + " 执行成功\n")
        else:
            # 其他可运行脚本
            self.set_status("② 运行 " + kind + ": " + name)
            cmd = self._runnable_cmd(kind, name)
            if self.run_cmd(cmd) != 0:
                self.log("❌ " + name + " 运行失败\n")
                if getattr(self, "copy_after_var", None) and self.copy_after_var.get():
                    self.root.after(0, self._copy_silent)
                self.set_status(name + " 运行失败")
                return
            self.log("✅ " + name + " 执行成功\n")

        if getattr(self, "copy_after_var", None) and self.copy_after_var.get():
            self.root.after(0, self._copy_silent)

    def _pick_runnable(self, tasks):
        """扫描 tasks 里所有 write 的文件，返回最后一个可运行的 (kind, name)。"""
        runnable = None
        for t in tasks:
            if t.get("op") != "write" or not t.get("path"):
                continue
            p = t.get("path")
            name = os.path.basename(p)
            ext = os.path.splitext(name)[1].lower()
            if name.startswith("patch-") and ext in (".cjs", ".js", ".py", ".ps1", ".sh"):
                runnable = ("patch", name)
            elif ext in (".cjs", ".js"):
                runnable = ("node", name)
            elif ext == ".py":
                runnable = ("python", name)
            elif ext == ".ps1":
                runnable = ("powershell", name)
            elif ext == ".sh":
                runnable = ("bash", name)
        return runnable

    def _runnable_cmd(self, kind, name):
        if kind == "node":
            return ["node", name]
        if kind == "python":
            return [_find_python(self.work_dir, self._cfg.get("python_path")), name]
        if kind == "powershell":
            return ["powershell", "-ExecutionPolicy", "Bypass", "-File", name]
        if kind == "bash":
            return ["bash", name]
        return [name]

    def run_ops_patch_check(self):
        name = self.patch_var.get().strip()
        if not name:
            return messagebox.showwarning("提示", "先选 Patch 脚本")
        threading.Thread(target=self._bg_ops_patch_check, args=(name,), daemon=True).start()

    def _bg_ops_patch_check(self, name):
        self.clear_log()
        raw = self.ops_text.get("1.0", "end").strip()
        if raw:
            try:
                tasks = json.loads(raw)
                if isinstance(tasks, list):
                    self.set_status("① 文件操作...")
                    ok, fail = self._exec_tasks(tasks)
                    self.log(f"\n文件操作: {ok} 成功 / {fail} 失败\n\n")
            except Exception as e:
                self.log(f"[JSON 解析失败] {e}\n")
        self.set_status("② Patch...")
        if self.run_cmd(_patch_cmd(name, self.work_dir, self._cfg.get("python_path"))) != 0:
            self.log("❌ Patch 失败\n")
            return
        self.log("✅ Patch 成功\n\n")
        self.set_status("③ Typecheck...")
        if self.run_cmd(_verify_cmd_parts(self._cfg)) != 0:
            self.log("❌ Typecheck 失败\n")
            return
        self.log("✅ Typecheck 通过\n\n")
        self.run_cmd(["git", "status", "--short"])
        self.set_status("文件操作 + Patch + Typecheck 通过")


if __name__ == "__main__":
    root = tk.Tk()
    App(root)
    root.mainloop()